import { describe, expect, test } from "bun:test";
import { Agent } from "../../../src/agent";
import {
  AssistantEventStream,
  type AssistantMessage,
  type Model,
  type ModelContext,
  type ModelMetadata,
} from "../../../src/core";
import {
  ConversationRuntime,
  type ConversationRuntimeEvent,
  createWakeScheduler,
} from "../../../src/kana";
import { MockModel } from "../../../src/providers/mock";

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

    await runtime.submit({ role: "user", content: "Finish the task." });

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

  test("owns session replacement and preserves state across Agent reconfiguration", async () => {
    const creations: Array<{
      configuration?: string;
      messages: unknown[];
      sessionId?: string;
    }> = [];
    const runtime = new ConversationRuntime<string>({
      ...createRuntimeOptions(),
      initialSession: {
        id: "session-a",
        messages: [{ role: "user", content: "Existing context." }],
        timeline: [],
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
        messages: [{ role: "user", content: "Resumed context." }],
        timeline: [],
      }),
    });

    runtime.reconfigure("alternate-model");
    expect(runtime.state.messages).toEqual([{ role: "user", content: "Existing context." }]);

    const fork = runtime.forkSession("Continue.");
    expect(fork.id).toBe("session-fork");
    expect(fork.messages).toEqual([{ role: "user", content: "Existing context." }]);

    const resumed = runtime.resumeSession("session-resumed");
    expect(resumed.messages).toEqual([{ role: "user", content: "Resumed context." }]);

    const fresh = runtime.startNewSession();
    expect(fresh).toMatchObject({ id: "session-new", messages: [], timeline: [] });
    expect(creations).toEqual([
      {
        configuration: undefined,
        messages: [{ role: "user", content: "Existing context." }],
        sessionId: "session-a",
      },
      {
        configuration: "alternate-model",
        messages: [{ role: "user", content: "Existing context." }],
        sessionId: "session-a",
      },
      {
        configuration: undefined,
        messages: [{ role: "user", content: "Existing context." }],
        sessionId: "session-fork",
      },
      {
        configuration: undefined,
        messages: [{ role: "user", content: "Resumed context." }],
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

    const userRun = runtime.submit({ role: "user", content: "Start." });
    await waitFor(() => model.contexts.length === 1);
    wakeScheduler.schedule({
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
      role: "user",
      content: "[Scheduled wake event]\nCheck progress.",
      source: "scheduled",
    });
    model.finish(1, "Wake done.");
    await runtime.waitForIdle();
    expect(sources).toEqual(["user", "scheduled"]);

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

    await runtime.submit({ role: "user", content: "Continue." });

    expect(observed[0]).toBe("run_start");
    expect(observed.at(-1)).toBe("run_end");
    await runtime.close();
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
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsParallelToolCalls: true,
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
      role: "assistant",
      content: [{ type: "text", text }],
    };
    stream.push({ type: "start", snapshot: { role: "assistant", content: [] } });
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition was not met.");
}
