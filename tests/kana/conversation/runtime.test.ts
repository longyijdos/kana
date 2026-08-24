import { describe, expect, test } from "bun:test";
import { Agent } from "../../../src/agent";
import {
  AssistantEventStream,
  type AssistantMessage,
  type Model,
  type ModelContext,
  type ModelMetadata,
  type UserMessage,
} from "../../../src/core";
import {
  ConversationRuntime,
  type ConversationRuntimeEvent,
  createWakeScheduler,
  type KanaTodoStateChange,
} from "../../../src/kana";
import { MockModel } from "../../../src/providers/mock";
import { messageIdentityForTest, messageIdForTest } from "../../helpers/messages";

describe("ConversationRuntime", () => {
  test("runs one complete Agent turn and publishes frontend-neutral lifecycle events", async () => {
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      createAgent: (options) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock", response: "Done." }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe((event) => {
      events.push(event);
    });

    await runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Finish the task.",
    });

    expect(events[0]).toMatchObject({
      type: "run_start",
      source: "user",
      input: { role: "user", content: "Finish the task." },
    });
    expect(
      events.filter((event) => event.type === "agent_event").map((event) => event.event.type),
    ).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_end",
      source: "user",
      event: { type: "agent_end", reason: "stop" },
    });
    expect(runtime.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    await runtime.close();
  });

  test("publishes committed todo state during the active run", async () => {
    const model = new ControlledModel();
    const events: ConversationRuntimeEvent[] = [];
    let commitTodoState: ((change: KanaTodoStateChange) => void) | undefined;
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [], todoState: [] },
      createAgent: (options) => {
        commitTodoState = options.onTodoStateCommitted;
        return new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        });
      },
    });
    runtime.subscribe((event) => events.push(event));

    const run = runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Implement the feature.",
    });
    await waitFor(() => model.contexts.length === 1);
    commitTodoState?.({
      toolCallId: "call-todo",
      items: [{ content: "Implement the feature", status: "in_progress" }],
    });

    expect(runtime.todoState).toEqual([
      { content: "Implement the feature", status: "in_progress" },
    ]);
    expect(events).toContainEqual({
      type: "todo_state_changed",
      source: "user",
      change: {
        toolCallId: "call-todo",
        items: [{ content: "Implement the feature", status: "in_progress" }],
      },
    });

    model.finish(0, "Done.");
    await run;
    await runtime.close();
  });

  test("owns session replacement and preserves state across Agent reconfiguration", async () => {
    const creations: Array<{
      configuration?: string;
      messages: unknown[];
      sessionId?: string;
    }> = [];
    const existingMessage = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Existing context.",
    };
    const resumedMessage = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Resumed context.",
    };
    const existingTodoState = [{ content: "Keep this state", status: "in_progress" as const }];
    const runtime = new ConversationRuntime<string>({
      ...createRuntimeOptions(),
      initialSession: {
        id: "session-a",
        messages: [existingMessage],
        timeline: [],
        todoState: existingTodoState,
      },
      createAgent: (options) => {
        creations.push({
          configuration: options.configuration,
          messages: options.messages ?? [],
          sessionId: options.sessionId,
        });
        return new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        });
      },
      createNewSession: () => ({ id: "session-new" }),
      forkSession: () => ({ id: "session-fork" }),
      loadSession: (sessionId) => ({
        id: sessionId,
        messages: [resumedMessage],
        timeline: [],
      }),
    });

    runtime.reconfigure("alternate-model");
    expect(runtime.state.messages).toEqual([existingMessage]);

    const fork = runtime.forkSession("Continue.");
    expect(fork.id).toBe("session-fork");
    expect(fork.messages).toEqual([existingMessage]);
    expect(fork.todoState).toEqual(existingTodoState);
    fork.todoState?.splice(0);
    expect(runtime.todoState).toEqual(existingTodoState);

    const resumed = runtime.resumeSession("session-resumed");
    expect(resumed.messages).toEqual([resumedMessage]);

    const fresh = runtime.startNewSession();
    expect(fresh).toMatchObject({ id: "session-new", messages: [], timeline: [], todoState: [] });
    expect(creations).toEqual([
      {
        configuration: undefined,
        messages: [existingMessage],
        sessionId: "session-a",
      },
      {
        configuration: "alternate-model",
        messages: [existingMessage],
        sessionId: "session-a",
      },
      {
        configuration: undefined,
        messages: [existingMessage],
        sessionId: "session-fork",
      },
      {
        configuration: undefined,
        messages: [resumedMessage],
        sessionId: "session-resumed",
      },
      {
        configuration: undefined,
        messages: [],
        sessionId: "session-new",
      },
    ]);

    await runtime.close();
  });

  test("queues due wakes behind an active run and drains them when the host is ready", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const wakeScheduler = createWakeScheduler({
      setTimeout: (callback) => {
        const id = timers.size + 1;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const model = new ControlledModel();
    const sources: string[] = [];
    let hostReady = true;
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      wakeScheduler,
      canStartScheduledRun: () => hostReady,
      createAgent: (options) =>
        new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe((event) => {
      if (event.type === "run_start") {
        sources.push(event.source);
      }
    });

    const userRun = runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Start.",
    });
    await waitFor(() => model.contexts.length === 1);
    const wake = wakeScheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 1,
      message: "Check progress.",
    });
    timers.get(1)?.();

    expect(model.contexts).toHaveLength(1);
    hostReady = false;
    model.finish(0, "First done.");
    await userRun;
    expect(model.contexts).toHaveLength(1);

    hostReady = true;
    runtime.notifyCanStartScheduledRun();
    await waitFor(() => model.contexts.length === 2);
    expect(model.contexts[1]?.messages.at(-1)).toEqual({
      id: wake.id,
      provenance: { kind: "scheduled_input", origin: "agent" },
      role: "user",
      content: "[Scheduled wake event]\nCheck progress.",
    });
    model.finish(1, "Wake done.");
    await runtime.waitForIdle();
    expect(sources).toEqual(["user", "scheduled"]);

    await runtime.close();
  });

  test("shares one FIFO between queued user input and due wake events", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const wakeScheduler = createWakeScheduler({
      setTimeout: (callback) => {
        const id = timers.size + 1;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const model = new ControlledModel();
    const sources: string[] = [];
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      wakeScheduler,
      createAgent: (options) =>
        new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe((event) => {
      if (event.type === "run_start") {
        sources.push(event.source);
      }
    });

    const userRun = runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Start.",
    });
    await waitFor(() => model.contexts.length === 1);
    const queuedInput: UserMessage = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Queued with Tab.",
      images: [
        {
          mimeType: "image/png",
          data: "aW1hZ2U=",
          width: 32,
          height: 16,
        },
      ],
    };
    runtime.queueInput(queuedInput);
    const wake = wakeScheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 1,
      message: "Scheduled after the queued input.",
    });
    expect(runtime.inputQueue.pending).toMatchObject([
      {
        kind: "queued",
        content: "Queued with Tab.",
        imageCount: 1,
      },
    ]);
    expect(runtime.inputQueue.scheduled).toMatchObject([
      {
        sessionId: "session-a",
        message: "Scheduled after the queued input.",
      },
    ]);
    timers.get(1)?.();
    expect(runtime.inputQueue.pending).toMatchObject([
      {
        kind: "queued",
        content: "Queued with Tab.",
        imageCount: 1,
      },
      {
        kind: "scheduled",
        content: "Scheduled after the queued input.",
      },
    ]);
    expect(runtime.inputQueue.scheduled).toEqual([]);

    model.finish(0, "First done.");
    await userRun;
    await waitFor(() => model.contexts.length === 2);
    expect(model.contexts[1]?.messages.at(-1)).toEqual(queuedInput);

    model.finish(1, "Queued input done.");
    await waitFor(() => model.contexts.length === 3);
    expect(model.contexts[2]?.messages.at(-1)).toEqual({
      id: wake.id,
      provenance: { kind: "scheduled_input", origin: "agent" },
      role: "user",
      content: "[Scheduled wake event]\nScheduled after the queued input.",
    });

    model.finish(2, "Wake done.");
    await runtime.waitForIdle();
    expect(sources).toEqual(["user", "user", "scheduled"]);

    await runtime.close();
  });

  test("creates user scheduled input and cancels future or pending delivery by stable ID", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    let nextTimer = 0;
    const ids = [messageIdForTest("future-wake"), messageIdForTest("pending-wake")];
    const wakeScheduler = createWakeScheduler({
      now: () => new Date("2026-08-08T08:00:00.000Z"),
      createId: () => ids.shift() as (typeof ids)[number],
      setTimeout: (callback) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      wakeScheduler,
      canStartQueuedRun: () => false,
      createAgent: (options) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });

    const future = runtime.scheduleInput(5, "  Review the output.  ");
    expect(future).toMatchObject({
      id: "future-wake",
      origin: "user",
      message: "Review the output.",
    });
    expect(runtime.inputQueue.scheduled).toMatchObject([
      { id: "future-wake", origin: "user", message: "Review the output." },
    ]);
    expect(runtime.cancelScheduledInput(future.id)).toBe("future");
    expect(runtime.inputQueue.scheduled).toEqual([]);

    const pending = runtime.scheduleInput(1, "Continue after the timer.");
    timers.get(2)?.();
    expect(runtime.inputQueue.pending).toMatchObject([
      {
        id: "pending-wake",
        kind: "scheduled",
        content: "Continue after the timer.",
        origin: "user",
        dueAt: pending.dueAt,
      },
    ]);
    expect(runtime.cancelScheduledInput(pending.id)).toBe("pending");
    expect(runtime.cancelScheduledInput(pending.id)).toBe("not_found");
    expect(runtime.inputQueue.pending).toEqual([]);
    expect(() => runtime.scheduleInput(0, "Too soon.")).toThrow("between 1 minute and 24 hours");
    expect(() => runtime.scheduleInput(1, "   ")).toThrow("between 1 and 4000 characters");

    await runtime.close();
  });

  test("rejects scheduled input when scheduled runs are disabled", async () => {
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      scheduledRuns: false,
      createAgent: (options) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });

    expect(() => runtime.scheduleInput(1, "Never deliver this message.")).toThrow(
      "Scheduled messages are unavailable when scheduled runs are disabled.",
    );
    expect(runtime.inputQueue).toEqual({ pending: [], scheduled: [] });

    await runtime.close();
  });

  test("steers input into the active run after its current turn", async () => {
    const model = new ControlledModel();
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      createAgent: (options) =>
        new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe((event) => {
      events.push(event);
    });

    const userRun = runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Start.",
    });
    await waitFor(() => model.contexts.length === 1);
    const steeringInput = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Use the new direction.",
    };
    const steering = runtime.steer(steeringInput);

    model.finish(0, "First turn done.");
    await waitFor(() => model.contexts.length === 2);
    expect(model.contexts[1]?.messages.at(-1)).toEqual(steeringInput);

    model.finish(1, "Steered turn done.");
    expect(await steering).toBe("steered");
    await userRun;
    expect(
      events.some((event) => event.type === "agent_event" && event.event.type === "turn_input"),
    ).toBe(true);

    await runtime.close();
  });

  test("falls back to a queued run when steering reaches the turn limit", async () => {
    const model = new ControlledModel();
    const sources: string[] = [];
    let hostReady = false;
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      canStartQueuedRun: () => hostReady,
      createAgent: (options) =>
        new Agent({
          model,
          maxTurns: 1,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe((event) => {
      if (event.type === "run_start") {
        sources.push(event.source);
      }
    });

    const userRun = runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Start.",
    });
    await waitFor(() => model.contexts.length === 1);
    const steeringInput = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Follow up.",
    };
    const steering = runtime.steer(steeringInput);

    model.finish(0, "First run done.");
    await userRun;
    expect(await steering).toBe("queued");
    expect(runtime.inputQueue.pending).toMatchObject([
      {
        kind: "deferred",
        content: "Follow up.",
      },
    ]);
    hostReady = true;
    runtime.notifyCanStartQueuedRun();
    await waitFor(() => model.contexts.length === 2);
    expect(model.contexts[1]?.messages.at(-1)).toEqual(steeringInput);

    model.finish(1, "Follow-up run done.");
    await runtime.waitForIdle();
    expect(sources).toEqual(["user", "user"]);

    await runtime.close();
  });

  test("continues an active goal until its configured Agent-run limit", async () => {
    const model = new ControlledModel();
    const sources: string[] = [];
    const goalChanges: string[] = [];
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      goalMaxRounds: 2,
      createAgent: (options) =>
        new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe((event) => {
      if (event.type === "run_start") {
        sources.push(event.source);
      } else if (event.type === "goal_state_changed") {
        goalChanges.push(event.change);
      }
    });

    const firstRun = runtime.startGoal("Finish the bounded task");
    await waitFor(() => model.contexts.length === 1);
    expect(runtime.goal).toMatchObject({
      objective: "Finish the bounded task",
      status: "active",
      admittedRounds: 1,
      maxRounds: 2,
    });

    model.finish(0, "Made progress.");
    await firstRun;
    await waitFor(() => model.contexts.length === 2);
    expect(model.contexts[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      provenance: {
        kind: "goal_continuation",
        goalId: runtime.goal?.id,
        round: 2,
      },
    });
    expect(model.contexts[1]?.messages.at(-1)?.content).not.toContain("Round");
    expect(model.contexts[1]?.messages.at(-1)?.content).not.toContain("2 of 2");

    model.finish(1, "More progress.");
    await waitFor(() => runtime.goal?.status === "round_limit");
    expect(runtime.goal).toMatchObject({ admittedRounds: 2, maxRounds: 2 });
    expect(sources).toEqual(["goal", "goal"]);
    expect(goalChanges).toEqual(["started", "round_admitted", "round_limit"]);

    await runtime.close();
  });

  test("stops automatic continuation after an explicit goal update", async () => {
    const model = new ControlledModel();
    let lastEvent: ConversationRuntimeEvent | undefined;
    let commitGoal:
      | ((change: { status: "completed" | "blocked"; detail?: string }) => unknown)
      | undefined;
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      createAgent: (options) => {
        commitGoal = options.updateGoal;
        return new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        });
      },
    });
    runtime.subscribe((event) => {
      lastEvent = event;
    });

    const run = runtime.startGoal("Finish in one run");
    await waitFor(() => model.contexts.length === 1);
    commitGoal?.({ status: "completed", detail: "Objective achieved." });
    model.finish(0, "Done.");
    await run;
    await Promise.resolve();

    expect(runtime.goal).toMatchObject({
      status: "completed",
      detail: "Objective achieved.",
      admittedRounds: 1,
    });
    expect(model.contexts).toHaveLength(1);
    expect(lastEvent).toMatchObject({
      type: "run_end",
      source: "goal",
      goal: { status: "completed" },
    });

    await runtime.close();
  });

  test("drains queued human input before the next goal continuation", async () => {
    const model = new ControlledModel();
    const sources: string[] = [];
    let commitGoal:
      | ((change: { status: "completed" | "blocked"; detail?: string }) => unknown)
      | undefined;
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      goalMaxRounds: 3,
      createAgent: (options) => {
        commitGoal = options.updateGoal;
        return new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        });
      },
    });
    runtime.subscribe((event) => {
      if (event.type === "run_start") {
        sources.push(event.source);
      }
    });

    const firstRun = runtime.startGoal("Work across runs");
    await waitFor(() => model.contexts.length === 1);
    const queued = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Use this additional constraint.",
    };
    runtime.queueInput(queued);

    model.finish(0, "First round done.");
    await firstRun;
    await waitFor(() => model.contexts.length === 2);
    expect(model.contexts[1]?.messages.at(-1)).toEqual(queued);

    model.finish(1, "Constraint incorporated.");
    await waitFor(() => model.contexts.length === 3);
    expect(model.contexts[2]?.messages.at(-1)?.provenance.kind).toBe("goal_continuation");
    commitGoal?.({ status: "completed" });
    model.finish(2, "Goal done.");
    await runtime.waitForIdle();
    await waitFor(() => runtime.goal?.status === "completed");

    expect(sources).toEqual(["goal", "user", "goal"]);
    expect(runtime.goal?.admittedRounds).toBe(2);

    await runtime.close();
  });

  test("cancels an active goal when the Agent is aborted", async () => {
    const model = new ControlledModel();
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      createAgent: (options) =>
        new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });

    const run = runtime.startGoal("Keep working");
    await waitFor(() => model.contexts.length === 1);
    runtime.abort();
    expect(runtime.goal?.status).toBe("cancelled");

    model.finish(0, "Stopped.");
    await run;
    await Promise.resolve();
    expect(model.contexts).toHaveLength(1);

    await runtime.close();
  });

  test("isolates frontend listener failures", async () => {
    const observed: string[] = [];
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      createAgent: (options) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe(() => {
      throw new Error("renderer failed");
    });
    runtime.subscribe((event) => {
      observed.push(event.type);
    });

    await runtime.submit({ ...messageIdentityForTest("user"), role: "user", content: "Continue." });

    expect(observed[0]).toBe("run_start");
    expect(observed.at(-1)).toBe("run_end");
    await runtime.close();
  });

  test("keeps pending input only across same-session reconfiguration", async () => {
    const runtime = new ConversationRuntime<string>({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      canStartQueuedRun: () => false,
      createAgent: (options) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          inbox: options.inbox,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    const queued = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Stay only in this process.",
    };

    runtime.queueInput(queued);
    runtime.reconfigure("alternate-model");
    expect(runtime.inputQueue.pending.map((input) => input.id)).toEqual([queued.id]);

    runtime.resumeSession("session-b");
    expect(runtime.inputQueue).toEqual({ pending: [], scheduled: [] });

    await runtime.close();
  });

  test("does not accept queued or scheduled input after close", async () => {
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      canStartQueuedRun: () => false,
      createAgent: (options) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          inbox: options.inbox,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    const input = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Too late.",
    };

    await runtime.close();

    expect(runtime.queueInput(input)).toBe(input.id);
    expect(runtime.inputQueue).toEqual({ pending: [], scheduled: [] });
    expect(() => runtime.scheduleInput(5, "Too late.")).toThrow(
      "Conversation runtime is stopping.",
    );
  });
});

function createRuntimeOptions() {
  return {
    createNewSession: () => ({ id: "new" }),
    forkSession: () => ({ id: "fork" }),
    loadSession: (sessionId: string) => ({
      id: sessionId,
      messages: [],
      timeline: [],
    }),
  };
}

class ControlledModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "controlled",
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsParallelToolCalls: true,
    protocol: null,
    supportsHostedWebSearch: false,
  };
  readonly contexts: ModelContext[] = [];
  private readonly streams: AssistantEventStream[] = [];

  stream(context: ModelContext): AssistantEventStream {
    this.contexts.push({
      ...context,
      messages: structuredClone(context.messages),
    });
    const stream = new AssistantEventStream();
    this.streams.push(stream);
    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }

  finish(index: number, text: string): void {
    const stream = this.streams[index];
    if (!stream) {
      throw new Error(`Missing controlled stream ${index}.`);
    }
    const message: AssistantMessage = {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      content: [{ type: "text", text }],
    };
    stream.push({
      type: "start",
      snapshot: { ...message, content: [] },
    });
    stream.push({ type: "text_start", contentIndex: 0, snapshot: structuredClone(message) });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      snapshot: structuredClone(message),
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: text,
      snapshot: structuredClone(message),
    });
    stream.end({
      type: "done",
      reason: "stop",
      message: structuredClone(message),
    });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition was not met.");
}
