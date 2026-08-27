import type {
  Agent,
  AgentEvent,
  AgentInboxItem,
  AgentInboxSnapshot,
  AgentInputDelivery,
} from "@/agent";
import { createUserMessage, type MessageId, readMessageId, type UserMessage } from "@/core";
import type {
  BackgroundJobClient,
  BackgroundJobCompletionEvent,
  BackgroundJobSummary,
} from "@/jobs";
import type { Logger } from "@/logging";
import {
  type KanaGoalContinuationAdmission,
  KanaGoalController,
  type KanaGoalSnapshot,
  type KanaGoalUpdate,
} from "./goal-controller";
import type { WakeEvent, WakeEventOrigin, WakeScheduler } from "./wake-scheduler";

export type ConversationInputRunSource = "user" | "scheduled" | "goal" | "job";

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

export type ConversationInputRunRequest = {
  source: ConversationInputRunSource;
  input: UserMessage;
  prompt: UserMessage | UserMessage[];
};

export type ConversationInputRunResult =
  | {
      type: "completed";
      event: Extract<AgentEvent, { type: "agent_end" }>;
    }
  | {
      type: "failed";
      error: unknown;
    };

type ConversationGoalStateChange =
  | "started"
  | "round_admitted"
  | "completed"
  | "blocked"
  | "cancelled"
  | "round_limit"
  | "discarded";

type ConversationInputCoordinatorOptions = {
  wakeScheduler: WakeScheduler;
  goalMaxRounds: number;
  scheduledRuns?: boolean;
  backgroundJobCompletionRuns?: boolean;
  getBackgroundJobs?: (sessionId: string) => BackgroundJobClient | undefined;
  isRunActive: () => boolean;
  canSteer: () => boolean;
  canStartQueuedRun?: () => boolean;
  requestRun: (request: ConversationInputRunRequest) => Promise<ConversationInputRunResult>;
  onQueueChanged: (queue: ConversationInputQueueSnapshot) => void;
  onGoalChanged: (change: ConversationGoalStateChange, goal: KanaGoalSnapshot) => void;
  getLogger: () => Logger;
};

export class ConversationInputCoordinator {
  private readonly goalController = new KanaGoalController();
  private readonly wakeScheduler: WakeScheduler;
  private agent!: Agent;
  private sessionId?: string;
  private backgroundJobs?: BackgroundJobClient;
  private unsubscribeWakeEvents?: () => void;
  private unsubscribeWakeState?: () => void;
  private unsubscribeAgentInbox?: () => void;
  private unsubscribeBackgroundJobs?: () => void;
  private draining = false;
  private settlingRun = false;
  private changingSession = false;
  private stopping = false;

  constructor(private readonly options: ConversationInputCoordinatorOptions) {
    this.wakeScheduler = options.wakeScheduler;
  }

  initialize(agent: Agent, sessionId: string | undefined): void {
    this.agent = agent;
    this.sessionId = sessionId;
    this.observeAgentInbox();
    this.observeBackgroundJobs();
    this.unsubscribeWakeEvents = this.wakeScheduler.subscribe((event) => {
      this.queueWakeEvent(event);
    });
    this.unsubscribeWakeState = this.wakeScheduler.subscribeState(() => {
      this.emitQueueChanged();
    });
  }

  get queue(): ConversationInputQueueSnapshot {
    const inbox = this.agent.inbox;
    return {
      pending: [
        ...inbox.nextStep.map((item) => this.toPendingInput(item, "next-step")),
        ...inbox.nextTurn.map((item) => this.toPendingInput(item, "next-turn")),
      ],
      scheduled:
        this.sessionId === undefined || this.options.scheduledRuns === false
          ? []
          : this.wakeScheduler.list(this.sessionId),
    };
  }

  get goal(): KanaGoalSnapshot | undefined {
    return this.goalController.current;
  }

  get activeGoal(): KanaGoalSnapshot | undefined {
    return this.goalController.active;
  }

  get backgroundJobClient(): BackgroundJobClient | undefined {
    return this.backgroundJobs;
  }

  async submit(
    input: UserMessage,
    source: ConversationInputRunSource,
  ): Promise<ConversationInputRunResult> {
    const adjacentCompletions = source === "job" ? this.takePendingJobCompletionInputs() : [];
    const prompt = adjacentCompletions.length === 0 ? input : [input, ...adjacentCompletions];
    this.settlingRun = true;

    try {
      return await this.options.requestRun({ source, input, prompt });
    } finally {
      try {
        for (const completion of adjacentCompletions) {
          this.observeJobCompletion(completion);
        }
        this.observeJobCompletion(input);
      } finally {
        this.settlingRun = false;
        this.notifyRunSettled();
      }
    }
  }

  startGoal(objective: string): { goal: KanaGoalSnapshot; input: UserMessage } {
    const goal = this.goalController.start(objective, this.options.goalMaxRounds);
    this.options.onGoalChanged("started", goal);
    this.log("info", "conversation.goal_started", {
      goalId: goal.id,
      maxRounds: goal.maxRounds,
    });
    return {
      goal,
      input: createUserMessage({
        content: goal.objective,
        provenance: { kind: "user_input" },
      }),
    };
  }

  updateGoal(change: KanaGoalUpdate): KanaGoalSnapshot {
    const goal = this.goalController.update(change);
    this.options.onGoalChanged(change.status, goal);
    this.log("info", `conversation.goal_${goal.status}`, {
      goalId: goal.id,
      admittedRounds: goal.admittedRounds,
    });
    return goal;
  }

  cancelGoal(): void {
    const cancelled = this.goalController.cancel();
    if (!cancelled) {
      return;
    }
    this.options.onGoalChanged("cancelled", cancelled);
    this.log("info", "conversation.goal_cancelled", {
      goalId: cancelled.id,
      admittedRounds: cancelled.admittedRounds,
    });
  }

  blockGoal(detail: string): void {
    const blocked = this.goalController.block(detail);
    if (!blocked) {
      return;
    }
    this.options.onGoalChanged("blocked", blocked);
    this.log("warn", "conversation.goal_blocked", {
      goalId: blocked.id,
      admittedRounds: blocked.admittedRounds,
      reason: "run_failure",
    });
  }

  discardGoal(reason: "agent_reconfigured" | "session_changed" | "shutdown"): void {
    const discarded = this.goalController.discard();
    if (!discarded) {
      return;
    }
    this.options.onGoalChanged("discarded", discarded);
    this.log("info", "conversation.goal_discarded", {
      goalId: discarded.id,
      admittedRounds: discarded.admittedRounds,
      reason,
    });
  }

  resolveGoal(activeRunGoalId: string | undefined): KanaGoalSnapshot | undefined {
    const current = this.goalController.current;
    return current?.id === activeRunGoalId ? current : this.goalController.active;
  }

  goalForRun(goalId: string | undefined): KanaGoalSnapshot | undefined {
    const goal = this.goalController.current;
    return goal?.id === goalId ? goal : undefined;
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
    if (!this.sessionId) {
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
      sessionId: this.sessionId,
      afterMinutes,
      message: normalizedMessage,
      origin: "user",
    });
  }

  cancelScheduledInput(id: string): ConversationScheduledInputCancellation {
    if (!this.sessionId) {
      return "not_found";
    }

    const isCurrentSessionWake = this.wakeScheduler
      .list(this.sessionId)
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

  notifyCanStartRun(): void {
    void this.drain();
  }

  notifyRunSettled(): void {
    void this.drain();
  }

  observeAgentEvent(event: AgentEvent): void {
    if (event.type === "turn_input") {
      this.observeJobCompletion(event.message);
    }
  }

  replaceAgent(agent: Agent): void {
    this.unsubscribeAgentInbox?.();
    this.agent = agent;
    this.observeAgentInbox();
  }

  beginSessionChange(): void {
    this.changingSession = true;
    this.pauseBackgroundJobObservation();
  }

  cancelSessionChange(): void {
    this.changingSession = false;
  }

  pauseBackgroundJobObservation(): void {
    this.unsubscribeBackgroundJobs?.();
    this.unsubscribeBackgroundJobs = undefined;
  }

  cancelCurrentSessionInputs(): void {
    if (this.sessionId) {
      this.wakeScheduler.cancelSession(this.sessionId);
    }
    this.agent.clearInbox();
    this.discardGoal("session_changed");
  }

  adoptSession(agent: Agent, sessionId: string): void {
    this.sessionId = sessionId;
    this.replaceAgent(agent);
    this.observeBackgroundJobs();
    this.changingSession = false;
  }

  emitCurrentQueue(): void {
    this.emitQueueChanged();
  }

  prepareForShutdown(): void {
    this.stopping = true;
    this.discardGoal("shutdown");
    this.unsubscribeWakeEvents?.();
    this.unsubscribeWakeState?.();
    this.unsubscribeAgentInbox?.();
    this.pauseBackgroundJobObservation();
    this.agent.clearInbox();
  }

  finishShutdown(): void {
    this.wakeScheduler.dispose();
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
      this.handleGoalRoundLimit(admission);
      return undefined;
    }

    const goal = admission.goal;
    const input = createUserMessage({
      content: [
        "[Goal continuation]",
        "Continue the active goal using the authoritative runtime context.",
      ].join("\n"),
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
    this.options.onGoalChanged("round_admitted", goal);
    this.log("info", "conversation.goal_round_admitted", {
      goalId: goal.id,
      admittedRounds: goal.admittedRounds,
      maxRounds: goal.maxRounds,
    });
    return this.agent.shiftNextTurnInput();
  }

  private handleGoalRoundLimit(
    admission: Extract<KanaGoalContinuationAdmission, { type: "round_limit" }>,
  ): void {
    this.options.onGoalChanged("round_limit", admission.goal);
    this.log("info", "conversation.goal_round_limit_reached", {
      goalId: admission.goal.id,
      admittedRounds: admission.goal.admittedRounds,
    });
  }

  private resolveRunSource(delivery: AgentInputDelivery): ConversationInputRunSource {
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

  private async drain(): Promise<void> {
    if (
      this.stopping ||
      this.changingSession ||
      this.draining ||
      this.settlingRun ||
      this.options.isRunActive() ||
      !this.canStartQueuedRun()
    ) {
      return;
    }

    this.draining = true;
    try {
      while (
        !this.stopping &&
        !this.changingSession &&
        !this.options.isRunActive() &&
        this.canStartQueuedRun()
      ) {
        const next = this.agent.inbox.nextTurn[0];
        if (next?.delivery.kind === "job" && this.options.backgroundJobCompletionRuns === false) {
          return;
        }
        const submission =
          this.agent.shiftNextTurnInput() ?? this.createGoalContinuationSubmission();
        if (!submission) {
          return;
        }

        const source = this.resolveRunSource(submission.delivery);
        this.log("info", "conversation.queued_input_started", {
          source,
          pendingInputCount: this.agent.inbox.nextTurn.length,
        });
        await this.submit(submission.message, source).catch(() => undefined);
      }
    } finally {
      this.draining = false;
    }
  }

  private canStartQueuedRun(): boolean {
    return this.options.canStartQueuedRun?.() !== false;
  }

  private observeAgentInbox(): void {
    this.unsubscribeAgentInbox = this.agent.subscribeInbox(() => {
      this.emitQueueChanged();
      void this.drain();
    });
  }

  private observeBackgroundJobs(): void {
    this.pauseBackgroundJobObservation();
    this.backgroundJobs = this.sessionId
      ? this.options.getBackgroundJobs?.(this.sessionId)
      : undefined;
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
    const lane = this.options.canSteer() ? "next-step" : "next-turn";
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

  private emitQueueChanged(): void {
    if (!this.stopping) {
      this.options.onQueueChanged(this.queue);
    }
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

  private log(
    level: "info" | "warn" | "error",
    event: string,
    metadata?: Record<string, unknown>,
  ): void {
    try {
      this.options.getLogger()[level](event, metadata);
    } catch {
      // Diagnostics must not change input scheduling or cancellation behavior.
    }
  }
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
