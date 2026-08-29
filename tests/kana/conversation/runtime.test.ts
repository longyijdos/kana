import { describe, expect, test } from "bun:test";
import { Agent } from "../../../src/agent";
import {
  AssistantEventStream,
  type AssistantMessage,
  type Model,
  type ModelContext,
  type ModelMetadata,
} from "../../../src/core";
import { BackgroundJobManager } from "../../../src/jobs";
import {
  ConversationRuntime,
  type ConversationRuntimeEvent,
  createWakeScheduler,
  type KanaTodoStateChange,
} from "../../../src/kana";
import { MockModel } from "../../../src/providers/mock";
import { deferred } from "../../helpers/async-control";
import { messageIdentityForTest } from "../../helpers/messages";

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
    const disposals: Array<{ sessionId: string; source: string }> = [];
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
      disposeSession: async (sessionId, source, foregroundSettled) => {
        await foregroundSettled;
        disposals.push({ sessionId, source });
      },
    });

    runtime.reconfigure("alternate-model");
    expect(runtime.state.messages).toEqual([existingMessage]);

    const fork = await runtime.forkSession("Continue.");
    expect(fork.id).toBe("session-fork");
    expect(fork.messages).toEqual([existingMessage]);
    expect(fork.todoState).toEqual(existingTodoState);
    fork.todoState?.splice(0);
    expect(runtime.todoState).toEqual(existingTodoState);

    const resumed = await runtime.resumeSession("session-resumed");
    expect(resumed.messages).toEqual([resumedMessage]);

    const fresh = await runtime.startNewSession();
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
    expect(disposals).toEqual([
      { sessionId: "session-a", source: "session_disposal" },
      { sessionId: "session-fork", source: "session_disposal" },
      { sessionId: "session-resumed", source: "session_disposal" },
      { sessionId: "session-new", source: "shutdown" },
    ]);
  });

  test("awaits asynchronous deletion and refuses to delete the active session", async () => {
    let finishDeletion: (() => void) | undefined;
    const deletedSessionIds: string[] = [];
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      deleteSession: async (sessionId) => {
        await new Promise<void>((resolve) => {
          finishDeletion = resolve;
        });
        deletedSessionIds.push(sessionId);
        return true;
      },
      createAgent: (options) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });

    const deletion = runtime.deleteSession("session-b");
    await Promise.resolve();
    expect(deletedSessionIds).toEqual([]);
    finishDeletion?.();

    expect(await deletion).toBe(true);
    expect(await runtime.deleteSession("session-a")).toBe(false);
    expect(deletedSessionIds).toEqual(["session-b"]);
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
      canStartQueuedRun: () => hostReady,
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
    runtime.notifyCanStartQueuedRun();
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

  test("delivers a Job completion as the next step of an active Agent run", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const completion = deferredJob();
    const model = new ControlledModel();
    const sources: string[] = [];
    const runtime = new ConversationRuntime({
      ...createRuntimeOptions(),
      initialSession: { id: "session-a", messages: [], timeline: [] },
      getBackgroundJobs: () => jobs,
      createAgent: (options) =>
        new Agent({
          model,
          messages: options.messages,
          inbox: options.inbox,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    runtime.subscribe((event) => {
      if (event.type === "run_start") {
        sources.push(event.source);
      }
    });
    const job = jobs.start({ kind: "test", label: "build", run: () => completion.promise });

    const run = runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Start the build.",
    });
    await waitFor(() => model.contexts.length === 1);
    completion.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => runtime.inputQueue.pending.some((input) => input.kind === "job"));
    expect(runtime.inputQueue.pending).toMatchObject([
      { kind: "job", jobId: job.id, content: expect.stringContaining("completed") },
    ]);

    model.finish(0, "Initial turn done.");
    await waitFor(() => model.contexts.length === 2);
    expect(model.contexts[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      provenance: { kind: "job_completion", jobId: job.id },
      content: expect.stringContaining("reached completed"),
    });
    model.finish(1, "Completion handled.");
    await run;

    expect(sources).toEqual(["user"]);
    expect(jobs.context()).toEqual([]);
    await runtime.close();
    await manager.close();
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

    await runtime.resumeSession("session-b");
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
    goalMaxRounds: 8,
    createNewSession: () => ({ id: "new" }),
    forkSession: () => ({ id: "fork" }),
    loadSession: (sessionId: string) => ({
      id: sessionId,
      messages: [],
      timeline: [],
    }),
  };
}

function deferredJob(): {
  promise: Promise<{ status: "completed"; exitCode: number }>;
  resolve(value: { status: "completed"; exitCode: number }): void;
} {
  return deferred();
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
