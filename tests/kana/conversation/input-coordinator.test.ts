import { describe, expect, test } from "bun:test";
import { Agent } from "../../../src/agent";
import type { MessageId, UserMessage } from "../../../src/core";
import { type BackgroundJobClient, BackgroundJobManager } from "../../../src/jobs";
import {
  ConversationInputCoordinator,
  type ConversationInputQueueSnapshot,
  type ConversationInputRunRequest,
  type ConversationInputRunResult,
} from "../../../src/kana/conversation/input-coordinator";
import {
  createWakeScheduler,
  type WakeScheduler,
} from "../../../src/kana/conversation/wake-scheduler";
import { createNoopLogger } from "../../../src/logging";
import { MockModel } from "../../../src/providers/mock";
import { messageIdentityForTest, messageIdForTest } from "../../helpers/messages";

describe("ConversationInputCoordinator", () => {
  test("projects detached queue snapshots and clears process-local state on session change", () => {
    const { scheduler } = createTimerWakeScheduler([messageIdForTest("scheduled-input")]);
    let canStartQueuedRun = false;
    const harness = createHarness({
      wakeScheduler: scheduler,
      canStartQueuedRun: () => canStartQueuedRun,
    });
    const queuedInput = createInput("queued-input", "Queued input.");

    harness.coordinator.queueInput(queuedInput);
    const scheduled = harness.coordinator.scheduleInput(5, "Scheduled input.");
    const snapshot = harness.coordinator.queue;

    expect(snapshot.pending).toMatchObject([
      { id: queuedInput.id, kind: "queued", content: "Queued input." },
    ]);
    expect(snapshot.scheduled).toMatchObject([
      { id: scheduled.id, sessionId: "session-a", message: "Scheduled input." },
    ]);
    expect(harness.agent.inbox.nextTurn.map((item) => item.message.id)).toEqual([queuedInput.id]);

    const pendingSnapshot = snapshot.pending[0];
    const scheduledSnapshot = snapshot.scheduled[0];
    if (pendingSnapshot) {
      pendingSnapshot.content = "Mutated projection.";
    }
    if (scheduledSnapshot) {
      scheduledSnapshot.message = "Mutated wake.";
      scheduledSnapshot.dueAt.setTime(0);
    }
    expect(harness.coordinator.queue.pending[0]?.content).toBe("Queued input.");
    expect(harness.coordinator.queue.scheduled[0]).toMatchObject({
      message: "Scheduled input.",
      dueAt: scheduled.dueAt,
    });

    harness.coordinator.beginSessionChange();
    const discardedInput = createInput("discarded-input", "Do not queue this.");
    expect(harness.coordinator.queueInput(discardedInput)).toBe(discardedInput.id);
    expect(harness.agent.inbox.nextTurn.map((item) => item.message.id)).toEqual([queuedInput.id]);
    expect(() => harness.coordinator.scheduleInput(1, "Do not schedule this.")).toThrow(
      "Conversation session is changing.",
    );
    harness.coordinator.startGoal("Do not continue the old session.");
    canStartQueuedRun = true;
    harness.coordinator.cancelCurrentSessionInputs();
    harness.coordinator.adoptSession(createAgent(), "session-b");

    expect(harness.requests).toEqual([]);
    expect(harness.coordinator.queue).toEqual({ pending: [], scheduled: [] });
    expect(harness.coordinator.goal).toBeUndefined();
    harness.close();
  });

  test("schedules normalized input and cancels future or pending delivery by stable ID", () => {
    const { scheduler, timers } = createTimerWakeScheduler([
      messageIdForTest("future-wake"),
      messageIdForTest("pending-wake"),
    ]);
    const harness = createHarness({ wakeScheduler: scheduler });

    const future = harness.coordinator.scheduleInput(5, "  Review the output.  ");
    expect(future).toMatchObject({
      id: "future-wake",
      origin: "user",
      message: "Review the output.",
    });
    expect(harness.coordinator.cancelScheduledInput(future.id)).toBe("future");
    expect(harness.coordinator.queue.scheduled).toEqual([]);

    const pending = harness.coordinator.scheduleInput(1, "Continue after the timer.");
    timers.get(2)?.();
    expect(harness.coordinator.queue.pending).toMatchObject([
      {
        id: "pending-wake",
        kind: "scheduled",
        content: "Continue after the timer.",
        origin: "user",
        dueAt: pending.dueAt,
      },
    ]);
    expect(harness.coordinator.cancelScheduledInput(pending.id)).toBe("pending");
    expect(harness.coordinator.cancelScheduledInput(pending.id)).toBe("not_found");

    for (const delay of [0, -1, 1.5, 1_441]) {
      expect(() => harness.coordinator.scheduleInput(delay, "Invalid delay.")).toThrow(
        "between 1 minute and 24 hours",
      );
    }
    for (const message of ["   ", "x".repeat(4_001)]) {
      expect(() => harness.coordinator.scheduleInput(1, message)).toThrow(
        "between 1 and 4000 characters",
      );
    }

    const disabled = createHarness({ scheduledRuns: false });
    expect(() => disabled.coordinator.scheduleInput(1, "Unavailable.")).toThrow(
      "Scheduled messages are unavailable when scheduled runs are disabled.",
    );
    expect(disabled.coordinator.queue).toEqual({ pending: [], scheduled: [] });

    disabled.close();
    harness.close();
  });

  test("drains one FIFO only after run and host gates settle", async () => {
    const firstRun = deferred<ConversationInputRunResult>();
    const { scheduler, timers } = createTimerWakeScheduler([messageIdForTest("scheduled")]);
    let runActive = true;
    let hostReady = false;
    const harness = createHarness({
      wakeScheduler: scheduler,
      isRunActive: () => runActive,
      canStartQueuedRun: () => hostReady,
      requestRun: (_request, requestIndex) =>
        requestIndex === 0 ? firstRun.promise : Promise.resolve(completedRun()),
    });
    const firstInput = createInput("first", "First input.");
    const lastInput = createInput("last", "Last input.");

    harness.coordinator.queueInput(firstInput);
    scheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 1,
      message: "Scheduled input.",
    });
    timers.get(1)?.();
    expect(harness.coordinator.queue.pending.map((input) => input.kind)).toEqual([
      "queued",
      "scheduled",
    ]);
    expect(harness.requests).toEqual([]);

    runActive = false;
    harness.coordinator.notifyRunSettled();
    expect(harness.requests).toEqual([]);

    hostReady = true;
    harness.coordinator.notifyCanStartRun();
    await waitFor(() => harness.requests.length === 1);
    harness.coordinator.queueInput(lastInput);
    expect(harness.requests).toHaveLength(1);

    firstRun.resolve(completedRun());
    await waitFor(() => harness.requests.length === 3);

    expect(harness.requests.map((request) => request.source)).toEqual([
      "user",
      "scheduled",
      "user",
    ]);
    expect(harness.requests.map((request) => request.input.id)).toEqual([
      firstInput.id,
      messageIdForTest("scheduled"),
      lastInput.id,
    ]);
    expect(harness.coordinator.queue.pending).toEqual([]);
    harness.close();
  });

  test("runs queued input before admitting a Goal continuation", async () => {
    const goalChanges: string[] = [];
    let canStartQueuedRun = false;
    const harness = createHarness({
      goalMaxRounds: 2,
      canStartQueuedRun: () => canStartQueuedRun,
      onGoalChanged: (change) => goalChanges.push(change),
    });

    const { input } = harness.coordinator.startGoal("Complete the refactor.");
    expect(await harness.coordinator.submit(input, "goal")).toEqual(completedRun());
    const queuedInput = createInput("queued-before-goal", "Handle this first.");
    harness.coordinator.queueInput(queuedInput);

    canStartQueuedRun = true;
    harness.coordinator.notifyCanStartRun();
    await waitFor(() => harness.coordinator.goal?.status === "round_limit");

    expect(harness.requests.map((request) => request.source)).toEqual(["goal", "user", "goal"]);
    expect(harness.requests[1]?.input).toEqual(queuedInput);
    expect(harness.requests[2]?.input).toMatchObject({
      provenance: { kind: "goal_continuation", round: 2 },
    });
    expect(goalChanges).toEqual(["started", "round_admitted", "round_limit"]);
    harness.close();
  });

  test("stops Goal continuation after an explicit terminal update", async () => {
    const run = deferred<ConversationInputRunResult>();
    const goalChanges: string[] = [];
    const harness = createHarness({
      canStartQueuedRun: () => true,
      requestRun: () => run.promise,
      onGoalChanged: (change) => goalChanges.push(change),
    });
    const { input } = harness.coordinator.startGoal("Finish in one run.");

    const submission = harness.coordinator.submit(input, "goal");
    await waitFor(() => harness.requests.length === 1);
    harness.coordinator.updateGoal({ status: "completed", detail: "Done." });
    run.resolve(completedRun());
    await submission;
    await Promise.resolve();

    expect(harness.requests).toHaveLength(1);
    expect(harness.coordinator.goal).toMatchObject({ status: "completed", detail: "Done." });
    expect(goalChanges).toEqual(["started", "completed"]);
    harness.close();
  });

  test("coalesces adjacent Job completions and preserves FIFO around user input", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 3 });
    const completions = [deferredJob(), deferredJob(), deferredJob()];
    let canStartQueuedRun = false;
    const harness = createHarness({
      getBackgroundJobs: () => jobs,
      canStartQueuedRun: () => canStartQueuedRun,
    });
    const started = completions.map((completion, index) =>
      jobs.start({ kind: "test", label: `job ${index + 1}`, run: () => completion.promise }),
    );

    completions[0]?.resolve({ status: "completed", exitCode: 0 });
    completions[1]?.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => harness.coordinator.queue.pending.length === 2);
    const humanInput = createInput("human", "Continue with this instruction.");
    harness.coordinator.queueInput(humanInput);
    completions[2]?.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => harness.coordinator.queue.pending.length === 4);

    expect(harness.coordinator.queue.pending.map((input) => input.kind)).toEqual([
      "job",
      "job",
      "queued",
      "job",
    ]);
    canStartQueuedRun = true;
    harness.coordinator.notifyCanStartRun();
    await waitFor(() => harness.requests.length === 3);

    expect(harness.requests.map((request) => request.source)).toEqual(["job", "user", "job"]);
    expect(harness.requests[0]?.prompt).toMatchObject([
      { provenance: { kind: "job_completion", jobId: started[0]?.id } },
      { provenance: { kind: "job_completion", jobId: started[1]?.id } },
    ]);
    expect(harness.requests[1]?.input).toEqual(humanInput);
    expect(harness.requests[2]?.input).toMatchObject({
      provenance: { kind: "job_completion", jobId: started[2]?.id },
    });
    expect(jobs.context()).toEqual([]);

    harness.close();
    await manager.close();
  });

  test("queues active Job completion for steering and removes it when observed", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const completion = deferredJob();
    const harness = createHarness({
      getBackgroundJobs: () => jobs,
      canSteer: () => true,
    });
    const job = jobs.start({ kind: "test", label: "observed", run: () => completion.promise });

    completion.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => harness.coordinator.queue.pending.length === 1);

    expect(harness.agent.inbox.nextStep).toHaveLength(1);
    expect(harness.coordinator.queue.pending).toMatchObject([
      { kind: "job", jobId: job.id, content: expect.stringContaining("completed") },
    ]);

    jobs.observe(job.id);
    await waitFor(() => harness.coordinator.queue.pending.length === 0);

    harness.close();
    await manager.close();
  });
});

type HarnessOptions = {
  wakeScheduler?: WakeScheduler;
  sessionId?: string;
  goalMaxRounds?: number;
  scheduledRuns?: boolean;
  backgroundJobCompletionRuns?: boolean;
  getBackgroundJobs?: (sessionId: string) => BackgroundJobClient | undefined;
  isRunActive?: () => boolean;
  canSteer?: () => boolean;
  canStartQueuedRun?: () => boolean;
  requestRun?: (
    request: ConversationInputRunRequest,
    requestIndex: number,
  ) => Promise<ConversationInputRunResult>;
  onQueueChanged?: (queue: ConversationInputQueueSnapshot) => void;
  onGoalChanged?: (change: string) => void;
};

function createHarness(options: HarnessOptions = {}) {
  const requests: ConversationInputRunRequest[] = [];
  const agent = createAgent();
  const coordinator = new ConversationInputCoordinator({
    wakeScheduler: options.wakeScheduler ?? createWakeScheduler(),
    goalMaxRounds: options.goalMaxRounds ?? 3,
    scheduledRuns: options.scheduledRuns,
    backgroundJobCompletionRuns: options.backgroundJobCompletionRuns,
    getBackgroundJobs: options.getBackgroundJobs,
    isRunActive: options.isRunActive ?? (() => false),
    canSteer: options.canSteer ?? (() => false),
    canStartQueuedRun: options.canStartQueuedRun ?? (() => false),
    requestRun: async (request) => {
      const requestIndex = requests.length;
      requests.push(structuredClone(request));
      return options.requestRun?.(request, requestIndex) ?? completedRun();
    },
    onQueueChanged: options.onQueueChanged ?? (() => undefined),
    onGoalChanged: (change) => options.onGoalChanged?.(change),
    getLogger: createNoopLogger,
  });
  coordinator.initialize(agent, options.sessionId === undefined ? "session-a" : options.sessionId);

  return {
    agent,
    coordinator,
    requests,
    close() {
      coordinator.prepareForShutdown();
      coordinator.finishShutdown();
    },
  };
}

function createTimerWakeScheduler(ids: MessageId[]) {
  const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
  let nextTimer = 0;
  const scheduler = createWakeScheduler({
    now: () => new Date("2026-08-27T08:00:00.000Z"),
    createId: () => {
      const id = ids.shift();
      if (!id) {
        throw new Error("Missing scheduled Message ID.");
      }
      return id;
    },
    setTimeout: (callback) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  return { scheduler, timers };
}

function createAgent(): Agent {
  return new Agent({
    model: new MockModel({ provider: "mock", model: "mock" }),
  });
}

function createInput(id: string, content: string): UserMessage {
  return {
    ...messageIdentityForTest("user"),
    id: messageIdForTest(id),
    role: "user",
    content,
  };
}

function completedRun(): ConversationInputRunResult {
  return {
    type: "completed",
    event: { type: "agent_end", reason: "stop", messages: [] },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function deferredJob(): {
  promise: Promise<{ status: "completed"; exitCode: number }>;
  resolve(value: { status: "completed"; exitCode: number }): void;
} {
  return deferred();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for condition.");
}
