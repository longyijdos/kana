import { describe, expect, test } from "bun:test";
import { Agent } from "../../../src/agent";
import type { UserMessage } from "../../../src/core";
import {
  ConversationInputCoordinator,
  type ConversationInputRunRequest,
  type ConversationInputRunResult,
} from "../../../src/kana/conversation/input-coordinator";
import { createWakeScheduler } from "../../../src/kana/conversation/wake-scheduler";
import { createNoopLogger } from "../../../src/logging";
import { MockModel } from "../../../src/providers/mock";
import { messageIdentityForTest, messageIdForTest } from "../../helpers/messages";

describe("ConversationInputCoordinator", () => {
  test("projects detached Agent inbox and wake snapshots while gating session transitions", () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const wakeScheduler = createWakeScheduler({
      now: () => new Date("2026-08-27T08:00:00.000Z"),
      createId: () => messageIdForTest("scheduled-input"),
      setTimeout: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const agent = createAgent();
    let canStartQueuedRun = false;
    let runRequestCount = 0;
    const coordinator = new ConversationInputCoordinator({
      wakeScheduler,
      goalMaxRounds: 3,
      canStartQueuedRun: () => canStartQueuedRun,
      isRunActive: () => false,
      canSteer: () => false,
      requestRun: async () => {
        runRequestCount += 1;
        return completedRun();
      },
      onQueueChanged: () => undefined,
      onGoalChanged: () => undefined,
      getLogger: createNoopLogger,
    });
    coordinator.initialize(agent, "session-a");

    const queuedInput = createInput("queued-input", "Queued input.");
    coordinator.queueInput(queuedInput);
    const scheduled = coordinator.scheduleInput(5, "Scheduled input.");
    const snapshot = coordinator.queue;

    expect(snapshot.pending).toMatchObject([
      { id: queuedInput.id, kind: "queued", content: "Queued input." },
    ]);
    expect(snapshot.scheduled).toMatchObject([
      { id: scheduled.id, sessionId: "session-a", message: "Scheduled input." },
    ]);
    expect(agent.inbox.nextTurn.map((item) => item.message.id)).toEqual([queuedInput.id]);

    const pendingSnapshot = snapshot.pending[0];
    const scheduledSnapshot = snapshot.scheduled[0];
    if (pendingSnapshot) {
      pendingSnapshot.content = "Mutated projection.";
    }
    if (scheduledSnapshot) {
      scheduledSnapshot.message = "Mutated wake.";
      scheduledSnapshot.dueAt.setTime(0);
    }
    expect(coordinator.queue.pending[0]?.content).toBe("Queued input.");
    expect(coordinator.queue.scheduled[0]).toMatchObject({
      message: "Scheduled input.",
      dueAt: scheduled.dueAt,
    });

    coordinator.beginSessionChange();
    const discardedInput = createInput("discarded-input", "Do not queue this.");
    expect(coordinator.queueInput(discardedInput)).toBe(discardedInput.id);
    expect(agent.inbox.nextTurn.map((item) => item.message.id)).toEqual([queuedInput.id]);
    expect(() => coordinator.scheduleInput(1, "Do not schedule this.")).toThrow(
      "Conversation session is changing.",
    );
    coordinator.startGoal("Do not continue the old session.");
    canStartQueuedRun = true;
    coordinator.cancelCurrentSessionInputs();
    coordinator.adoptSession(createAgent(), "session-b");
    expect(runRequestCount).toBe(0);
    expect(coordinator.queue).toEqual({ pending: [], scheduled: [] });
    expect(coordinator.goal).toBeUndefined();

    coordinator.prepareForShutdown();
    coordinator.finishShutdown();
  });

  test("requests FIFO runs before admitting a Goal continuation", async () => {
    const requests: ConversationInputRunRequest[] = [];
    const goalChanges: string[] = [];
    let canStartQueuedRun = false;
    const coordinator = new ConversationInputCoordinator({
      wakeScheduler: createWakeScheduler(),
      goalMaxRounds: 2,
      canStartQueuedRun: () => canStartQueuedRun,
      isRunActive: () => false,
      canSteer: () => false,
      requestRun: async (request) => {
        requests.push(structuredClone(request));
        return completedRun();
      },
      onQueueChanged: () => undefined,
      onGoalChanged: (change) => goalChanges.push(change),
      getLogger: createNoopLogger,
    });
    coordinator.initialize(createAgent(), "session-a");

    const { input } = coordinator.startGoal("Complete the refactor.");
    expect(await coordinator.submit(input, "goal")).toEqual(completedRun());
    const queuedInput = createInput("queued-before-goal", "Handle this first.");
    coordinator.queueInput(queuedInput);

    canStartQueuedRun = true;
    coordinator.notifyCanStartRun();
    await waitFor(() => coordinator.goal?.status === "round_limit");

    expect(requests.map((request) => request.source)).toEqual(["goal", "user", "goal"]);
    expect(requests[1]?.input).toEqual(queuedInput);
    expect(requests[2]?.input).toMatchObject({
      provenance: { kind: "goal_continuation", round: 2 },
    });
    expect(goalChanges).toEqual(["started", "round_admitted", "round_limit"]);

    coordinator.prepareForShutdown();
    coordinator.finishShutdown();
  });
});

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for condition.");
}
