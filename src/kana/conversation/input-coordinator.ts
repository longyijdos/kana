import type { Agent, AgentEvent, AgentInboxItem, AgentInputDelivery } from "@/agent";
import { createUserMessage, type MessageId, readMessageId, type UserMessage } from "@/core";
import type { BackgroundJobClient, BackgroundJobSummary, OwnedTaskEvent } from "@/jobs";
import type { Logger } from "@/logging";
import { shortId } from "@/utils";
import type { KanaSubagentClient, KanaSubagentSummary } from "../subagents";
import type { KanaUserTaskManager } from "../user-tasks";
import {
  type KanaGoalContinuationAdmission,
  KanaGoalController,
  type KanaGoalSnapshot,
  type KanaGoalUpdate,
} from "./goal-controller";
import type { WakeEvent, WakeEventOrigin, WakeScheduler } from "./wake-scheduler";

export type ConversationInputRunSource =
  | "user"
  | "scheduled"
  | "goal"
  | "job"
  | "subagent"
  | "user_task";

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
    }
  | {
      id: MessageId;
      kind: "subagent";
      content: string;
      agentId: string;
      imageCount?: number;
    }
  | {
      id: MessageId;
      kind: "user_task";
      content: string;
      taskId: string;
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
  subagentCompletionRuns?: boolean;
  getBackgroundJobs?: (sessionId: string) => BackgroundJobClient | undefined;
  getSubagents?: (sessionId: string) => KanaSubagentClient | undefined;
  getUserTasks?: (sessionId: string) => KanaUserTaskManager | undefined;
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
  // Latest delivery per repeating schedule, so a slow conversation does not
  // accumulate a backlog of identical wakes.
  private readonly repeatingDeliveries = new Map<MessageId, MessageId>();
  private agent!: Agent;
  private sessionId?: string;
  private backgroundJobs?: BackgroundJobClient;
  private subagents?: KanaSubagentClient;
  private completionSources: readonly CompletionSource[] = [];
  private unsubscribeWakeEvents?: () => void;
  private unsubscribeWakeState?: () => void;
  private unsubscribeAgentInbox?: () => void;
  private unsubscribeCompletions: readonly (() => void)[] = [];
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
    this.observeCompletions();
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

  get subagentClient(): KanaSubagentClient | undefined {
    return this.subagents;
  }

  async submit(
    input: UserMessage,
    source: ConversationInputRunSource,
  ): Promise<ConversationInputRunResult> {
    const completionKind =
      source === "job" || source === "subagent" || source === "user_task" ? source : undefined;
    const adjacentCompletions = completionKind
      ? this.takePendingCompletionInputs(completionKind)
      : [];
    const prompt = adjacentCompletions.length === 0 ? input : [input, ...adjacentCompletions];
    this.settlingRun = true;

    try {
      return await this.options.requestRun({ source, input, prompt });
    } finally {
      this.settlingRun = false;
      this.notifyRunSettled();
    }
  }

  startGoal(objective: string): { goal: KanaGoalSnapshot; input: UserMessage } {
    const goal = this.goalController.start(objective, this.options.goalMaxRounds);
    this.options.onGoalChanged("started", goal);
    this.options.getLogger().info("conversation.goal_started", {
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
    this.options.getLogger().info(`conversation.goal_${goal.status}`, {
      goalId: goal.id,
      admittedRounds: goal.admittedRounds,
    });
    return goal;
  }

  cancelGoal(): boolean {
    const cancelled = this.goalController.cancel();
    if (!cancelled) {
      return false;
    }
    this.options.onGoalChanged("cancelled", cancelled);
    this.options.getLogger().info("conversation.goal_cancelled", {
      goalId: cancelled.id,
      admittedRounds: cancelled.admittedRounds,
    });
    return true;
  }

  blockGoal(detail: string): void {
    const blocked = this.goalController.block(detail);
    if (!blocked) {
      return;
    }
    this.options.onGoalChanged("blocked", blocked);
    this.options.getLogger().warn("conversation.goal_blocked", {
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
    this.options.getLogger().info("conversation.goal_discarded", {
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
      this.options.getLogger().warn("conversation.input_discarded", {
        reason: this.stopping ? "stopping" : "session_changing",
      });
      return input.id;
    }
    this.agent.enqueueInput(input, "next-turn", { kind: "queued" });
    this.options.getLogger().info("conversation.input_queued", {
      source: "user",
      pendingInputCount: this.agent.inbox.nextTurn.length,
    });
    return input.id;
  }

  scheduleInput(
    afterMinutes: number,
    message: string,
    options: { readonly repeat?: boolean } = {},
  ): WakeEvent {
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
      repeat: options.repeat,
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
      this.repeatingDeliveries.delete(readMessageId(id));
      this.options.getLogger().info("conversation.scheduled_input_cancelled", { state: "future" });
      return "future";
    }

    const pending = this.agent.inbox.nextTurn.find(
      (item) => item.message.id === id && item.delivery.kind === "scheduled",
    );
    if (!pending) {
      this.options.getLogger().info("conversation.scheduled_input_cancel_skipped", {
        reason: "not_found",
      });
      return "not_found";
    }

    this.agent.cancelInput(pending.message.id);
    this.options.getLogger().info("conversation.scheduled_input_cancelled", { state: "pending" });
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
      this.options.getLogger().warn("conversation.input_discarded", {
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
      this.observeCompletion(event.message);
    }
  }

  observeRunInputs(prompt: UserMessage | UserMessage[]): void {
    for (const input of Array.isArray(prompt) ? prompt : [prompt]) {
      this.observeCompletion(input);
    }
  }

  replaceAgent(agent: Agent): void {
    this.unsubscribeAgentInbox?.();
    this.agent = agent;
    this.observeAgentInbox();
  }

  beginSessionChange(): void {
    this.changingSession = true;
    this.pauseCompletionObservation();
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
    this.observeCompletions();
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
    this.pauseCompletionObservation();
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
    if (event.scheduleId) {
      const previous = this.repeatingDeliveries.get(event.scheduleId);
      if (previous && this.agent.inbox.nextTurn.some((item) => item.message.id === previous)) {
        this.options.getLogger().info("conversation.repeating_wake_skipped", {
          reason: "previous_pending",
        });
        return;
      }
      this.repeatingDeliveries.set(event.scheduleId, event.id);
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
        origin: event.origin,
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
    this.options.getLogger().info("conversation.automatic_input_queued", {
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
    this.options.getLogger().info("conversation.goal_round_admitted", {
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
    this.options.getLogger().info("conversation.goal_round_limit_reached", {
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
    if (delivery.kind === "subagent") {
      return "subagent";
    }
    if (delivery.kind === "user_task") {
      return "user_task";
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
        if (
          (next?.delivery.kind === "job" && this.options.backgroundJobCompletionRuns === false) ||
          (next?.delivery.kind === "subagent" && this.options.subagentCompletionRuns === false)
        ) {
          return;
        }
        const submission =
          this.agent.shiftNextTurnInput() ?? this.createGoalContinuationSubmission();
        if (!submission) {
          return;
        }

        const source = this.resolveRunSource(submission.delivery);
        this.options.getLogger().info("conversation.queued_input_started", {
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

  private observeCompletions(): void {
    this.pauseCompletionObservation();
    const { sessionId } = this;
    this.backgroundJobs = sessionId ? this.options.getBackgroundJobs?.(sessionId) : undefined;
    this.subagents = sessionId ? this.options.getSubagents?.(sessionId) : undefined;
    const userTasks = sessionId ? this.options.getUserTasks?.(sessionId) : undefined;
    this.completionSources = [
      ...(this.backgroundJobs
        ? [ownedTaskCompletions("job", this.backgroundJobs, formatBackgroundJobCompletion)]
        : []),
      ...(this.subagents
        ? [ownedTaskCompletions("subagent", this.subagents, formatSubagentCompletion)]
        : []),
      ...(userTasks ? [userTaskCompletions(userTasks)] : []),
    ];
    this.unsubscribeCompletions = this.completionSources.map((source) =>
      source.subscribe({
        settled: (completion) => this.queueCompletion(source.kind, completion),
        observed: (id) => this.discardCompletion(source.kind, id),
      }),
    );
  }

  private pauseCompletionObservation(): void {
    for (const unsubscribe of this.unsubscribeCompletions) unsubscribe();
    this.unsubscribeCompletions = [];
  }

  private queueCompletion(kind: CompletionKind, completion: Completion): void {
    if (this.stopping || this.changingSession) return;
    const lane = this.options.canSteer() ? "next-step" : "next-turn";
    const display = `${COMPLETION_LABELS[kind]} ${shortId(completion.id)} ${completion.outcome}`;
    const { message, delivery } = createCompletionInput(kind, completion, display);
    this.agent.enqueueInput(message, lane, delivery);
    this.options.getLogger().info(`conversation.${COMPLETION_LOG_NAMES[kind]}_completion_queued`, {
      [COMPLETION_ID_FIELDS[kind]]: completion.id,
      outcome: completion.outcome,
      delivery: lane,
    });
  }

  // The owner already consumed this completion through a tool, so a queued
  // notification for it would be redundant.
  private discardCompletion(kind: CompletionKind, id: string): void {
    if (this.stopping || this.changingSession) return;
    for (const item of [...this.agent.inbox.nextStep, ...this.agent.inbox.nextTurn]) {
      if (item.delivery.kind === kind && readCompletionId(item.delivery) === id) {
        this.agent.cancelInput(item.message.id);
      }
    }
  }

  private takePendingCompletionInputs(
    kind: "job" | "subagent" | "user_task",
  ): readonly UserMessage[] {
    const inputs: UserMessage[] = [];
    while (this.agent.inbox.nextTurn[0]?.delivery.kind === kind) {
      const item = this.agent.shiftNextTurnInput();
      if (!item) {
        break;
      }
      inputs.push(item.message);
    }
    return inputs;
  }

  private observeCompletion(message: UserMessage): void {
    const { provenance } = message;
    const completed =
      provenance.kind === "job_completion"
        ? (["job", provenance.jobId] as const)
        : provenance.kind === "subagent_completion"
          ? (["subagent", provenance.agentId] as const)
          : provenance.kind === "user_task_completion"
            ? (["user_task", provenance.taskId] as const)
            : undefined;
    if (completed === undefined) return;
    const [kind, id] = completed;
    this.completionSources.find((source) => source.kind === kind)?.observe(id);
  }

  private emitQueueChanged(): void {
    if (!this.stopping) {
      this.options.onQueueChanged(this.queue);
    }
  }

  private toPendingInput(
    { message, delivery }: AgentInboxItem,
    lane: "next-step" | "next-turn",
  ): ConversationPendingInput {
    if (delivery.kind === "steering" || delivery.kind === "queued") {
      return {
        id: message.id,
        kind:
          lane === "next-step" ? "steering" : delivery.kind === "steering" ? "deferred" : "queued",
        content: message.content,
        ...(message.images?.length ? { imageCount: message.images.length } : {}),
      };
    }
    const { displayContent, ...details } = delivery;
    return { id: message.id, content: displayContent, ...details };
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

function formatSubagentCompletion(subagent: KanaSubagentSummary): string {
  return [
    "[Subagent completion]",
    `Subagent ${subagent.id} (${subagent.profile}) reached ${subagent.status}.`,
    "Use wait_subagent to consume its final result before deciding the next action.",
  ].join("\n");
}

type CompletionKind = "job" | "subagent" | "user_task";

type Completion = { readonly id: string; readonly outcome: string; readonly content: string };

// A producer of asynchronous results that are reported back to the Agent as
// queued input. `observed` fires when the owner consumed a result directly.
type CompletionSource = {
  readonly kind: CompletionKind;
  subscribe(handlers: {
    settled(completion: Completion): void;
    observed(id: string): void;
  }): () => void;
  observe(id: string): void;
};

const COMPLETION_LABELS: Record<CompletionKind, string> = {
  job: "Background Job",
  subagent: "Subagent",
  user_task: "User task",
};

const COMPLETION_LOG_NAMES: Record<CompletionKind, string> = {
  job: "background_job",
  subagent: "subagent",
  user_task: "user_task",
};

const COMPLETION_ID_FIELDS: Record<CompletionKind, string> = {
  job: "jobId",
  subagent: "agentId",
  user_task: "taskId",
};

function ownedTaskCompletions<TSummary extends { readonly id: string; readonly status: string }>(
  kind: CompletionKind,
  client: {
    subscribe(listener: (event: OwnedTaskEvent<unknown, TSummary>) => void): () => void;
    observe(id: string): void;
  },
  format: (summary: TSummary) => string,
): CompletionSource {
  return {
    kind,
    observe: (id) => client.observe(id),
    subscribe: (handlers) =>
      client.subscribe((event) => {
        if (event.type === "settled") {
          handlers.settled({
            id: event.task.id,
            outcome: event.task.status,
            content: format(event.task),
          });
        } else if (event.type === "observed") {
          handlers.observed(event.task.id);
        }
      }),
  };
}

function userTaskCompletions(tasks: KanaUserTaskManager): CompletionSource {
  return {
    kind: "user_task",
    observe: (id) => tasks.observe(id),
    subscribe: (handlers) =>
      tasks.subscribe(({ task, response }) =>
        handlers.settled({
          id: task.id,
          outcome: task.status,
          content: [
            "[User task update]",
            `Task ${task.id} was ${task.status} by the user.`,
            `Task:\n${task.task}`,
            response ? `User response:\n${response}` : "The user returned the task to you.",
          ].join("\n"),
        }),
      ),
  };
}

function createCompletionInput(
  kind: CompletionKind,
  { id, content }: Completion,
  displayContent: string,
): { message: UserMessage; delivery: AgentInputDelivery } {
  switch (kind) {
    case "job":
      return {
        message: createUserMessage({ content, provenance: { kind: "job_completion", jobId: id } }),
        delivery: { kind, displayContent, jobId: id },
      };
    case "subagent":
      return {
        message: createUserMessage({
          content,
          provenance: { kind: "subagent_completion", agentId: id },
        }),
        delivery: { kind, displayContent, agentId: id },
      };
    case "user_task":
      return {
        message: createUserMessage({
          content,
          provenance: { kind: "user_task_completion", taskId: id },
        }),
        delivery: { kind, displayContent, taskId: id },
      };
  }
}

function readCompletionId(delivery: AgentInputDelivery): string | undefined {
  switch (delivery.kind) {
    case "job":
      return delivery.jobId;
    case "subagent":
      return delivery.agentId;
    case "user_task":
      return delivery.taskId;
    default:
      return undefined;
  }
}
