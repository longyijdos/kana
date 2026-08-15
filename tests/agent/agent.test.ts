import { describe, expect, test } from "bun:test";
import { Agent } from "../../src/agent";
import type { AgentEvent } from "../../src/agent/events";
import type { ModelContext } from "../../src/core/context";
import type { AssistantMessage, Message } from "../../src/core/messages";
import type { Model, ModelMetadata, ModelUsage } from "../../src/core/model";
import { AssistantEventStream } from "../../src/core/stream";
import type { Logger } from "../../src/logging";
import { messageIdentityForTest } from "../helpers/messages";

class TextModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "text",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsParallelToolCalls: true,
    protocol: null,
    supportsHostedWebSearch: false,
  };
  readonly contexts: ModelContext[] = [];

  constructor(
    private readonly response = "hello",
    private readonly usage?: ModelUsage,
    private readonly identity?: Pick<AssistantMessage, "id" | "provenance">,
  ) {}

  stream(context: ModelContext): AssistantEventStream {
    this.contexts.push({
      system: context.system,
      messages: structuredClone(context.messages),
      tools: context.tools,
      parallelToolCalls: context.parallelToolCalls,
      maxOutputTokens: context.maxOutputTokens,
      signal: context.signal,
    });

    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      const message: AssistantMessage = {
        ...(this.identity ?? messageIdentityForTest("assistant")),
        role: "assistant",
        content: [],
      };

      stream.push({
        type: "start",
        snapshot: structuredClone(message),
      });

      message.content.push({
        type: "text",
        text: this.response,
      });

      stream.push({
        type: "text_start",
        contentIndex: 0,
        snapshot: structuredClone(message),
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: this.response,
        snapshot: structuredClone(message),
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: this.response,
        snapshot: structuredClone(message),
      });
      stream.end({
        type: "done",
        reason: "stop",
        message: structuredClone(message),
        usage: this.usage,
      });
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

class AbortAwareModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "abort-aware",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsParallelToolCalls: true,
    protocol: null,
    supportsHostedWebSearch: false,
  };

  stream(context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      const message: AssistantMessage = {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        content: [],
      };

      const abort = (): void => {
        stream.error({
          type: "error",
          reason: "aborted",
          error: context.signal?.reason ?? new Error("aborted"),
          snapshot: structuredClone(message),
        });
      };

      stream.push({
        type: "start",
        snapshot: structuredClone(message),
      });

      message.content.push({
        type: "text",
        text: "partial",
      });

      stream.push({
        type: "text_start",
        contentIndex: 0,
        snapshot: structuredClone(message),
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        snapshot: structuredClone(message),
      });

      if (context.signal?.aborted) {
        abort();
        return;
      }

      context.signal?.addEventListener("abort", abort, { once: true });
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

describe("Agent", () => {
  test("uses a configurable default tool deadline", () => {
    expect(new Agent({ model: new TextModel() }).state.toolDeadlineMs).toBe(300_000);
    expect(
      new Agent({
        model: new TextModel(),
        toolDeadlineMs: 120_000,
      }).state.toolDeadlineMs,
    ).toBe(120_000);
    expect(
      () =>
        new Agent({
          model: new TextModel(),
          toolDeadlineMs: 0,
        }),
    ).toThrow("defaultDeadlineMs must be a positive integer.");
  });

  test("rejects invalid maxTurns during construction", () => {
    for (const maxTurns of [-2, 0, 1.5]) {
      expect(
        () =>
          new Agent({
            model: new TextModel(),
            maxTurns,
          }),
      ).toThrow("maxTurns must be -1 or a positive integer.");
    }
  });

  test("enables parallel tool calls only when requested and supported", async () => {
    const supportedModel = new TextModel();
    const supportedAgent = new Agent({
      model: supportedModel,
      parallelToolCalls: true,
    });
    await supportedAgent.prompt("supported");

    const unsupportedModel = new TextModel();
    unsupportedModel.metadata.supportsParallelToolCalls = false;
    const unsupportedAgent = new Agent({
      model: unsupportedModel,
      parallelToolCalls: true,
    });
    await unsupportedAgent.prompt("unsupported");

    const disabledModel = new TextModel();
    const disabledAgent = new Agent({
      model: disabledModel,
      parallelToolCalls: false,
    });
    await disabledAgent.prompt("disabled");

    expect(supportedModel.contexts[0]?.parallelToolCalls).toBe(true);
    expect(unsupportedModel.contexts[0]?.parallelToolCalls).toBe(false);
    expect(disabledModel.contexts[0]?.parallelToolCalls).toBe(false);
  });

  test("writes lifecycle events without logging message content", async () => {
    const records: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: (event, metadata) => records.push({ event, metadata }),
      info: (event, metadata) => records.push({ event, metadata }),
      warn: (event, metadata) => records.push({ event, metadata }),
      error: (event, metadata) => records.push({ event, metadata }),
    };
    const agent = new Agent({
      model: new TextModel("secret answer"),
      logger,
      loggerMetadata: { agentKind: "conversation" },
    });

    await agent.prompt("secret prompt");

    expect(records.map((record) => record.event)).toEqual([
      "agent.parallel_tool_calls_configured",
      "agent.run_started",
      "agent.started",
      "agent.turn_started",
      "agent.turn_ended",
      "agent.ended",
    ]);
    expect(records[0]).toEqual({
      event: "agent.parallel_tool_calls_configured",
      metadata: {
        agentKind: "conversation",
        requested: true,
        supported: true,
        enabled: true,
      },
    });
    expect(records[1]).toEqual({
      event: "agent.run_started",
      metadata: { agentKind: "conversation", promptMessageCount: 1 },
    });
    expect(JSON.stringify(records)).not.toContain("secret");
  });

  test("keeps logging failures outside the runtime control flow", async () => {
    const fail = () => {
      throw new Error("logger unavailable");
    };
    const agent = new Agent({
      model: new TextModel("hello"),
      logger: {
        debug: fail,
        info: fail,
        warn: fail,
        error: fail,
      },
    });

    await agent.prompt("hi");

    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  });

  test("runs prompts and appends loop messages once", async () => {
    const model = new TextModel("hello");
    const agent = new Agent({ model });
    const events: AgentEvent[] = [];
    const streamingRoles: string[] = [];

    agent.subscribe((event) => {
      events.push(structuredClone(event));
      if (event.type === "message_update") {
        streamingRoles.push(agent.state.streamingMessage?.role ?? "none");
      }
    });

    await agent.prompt("hi");

    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.pendingToolCalls.size).toBe(0);
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(agent.state.messages[1]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(streamingRoles).toEqual(["assistant", "assistant", "assistant"]);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
    });
  });

  test("streams agent events from the stateful agent", async () => {
    const agent = new Agent({
      model: new TextModel("streamed"),
    });
    const stream = agent.stream("hi");
    const events: AgentEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    const messages = await stream.result();

    expect(messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(agent.state.messages.slice(1)).toEqual(messages);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(events.at(0)).toMatchObject({
      type: "agent_start",
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
    });
  });

  test("keeps model usage on committed assistant messages", async () => {
    const usage: ModelUsage = {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      promptCacheHitTokens: 90,
      promptCacheMissTokens: 10,
      reasoningTokens: 5,
    };
    const commits: Message[][] = [];
    const agent = new Agent({
      model: new TextModel("metered", usage),
      onRunCommitted: ({ messages }) => {
        commits.push(messages);
      },
    });

    await agent.prompt("hi");

    expect(agent.state.messages[1]).toMatchObject({
      role: "assistant",
      usage,
    });
    expect(commits[0]?.[1]).toMatchObject({
      role: "assistant",
      usage,
    });
  });

  test("commits prompt and loop messages after agent_end updates state", async () => {
    const commits: Array<{
      messages: string[];
      stateMessages: string[];
      eventMessages: string[];
    }> = [];
    const agent = new Agent({
      model: new TextModel("committed"),
      onRunCommitted: ({ messages, state, event }) => {
        commits.push({
          messages: messages.map((message) => message.role),
          stateMessages: state.messages.map((message) => message.role),
          eventMessages: event.messages.map((message) => message.role),
        });
      },
    });

    await agent.prompt("hi");

    expect(commits).toEqual([
      {
        messages: ["user", "assistant"],
        stateMessages: ["user", "assistant"],
        eventMessages: ["assistant"],
      },
    ]);
  });

  test("journals the prompt and completed messages before the aggregate commit", async () => {
    const operations: string[] = [];
    const model = new TextModel("journaled");
    const agent = new Agent({
      model,
      journal: {
        startRun: ({ messages }) => {
          operations.push(`start:${messages.map((message) => message.role).join(",")}`);
          expect(model.contexts).toHaveLength(0);
        },
        appendMessage: ({ message }) => {
          operations.push(`message:${message.role}`);
        },
        appendCompaction: () => {
          operations.push("compaction");
        },
        endRun: ({ reason }) => {
          operations.push(`end:${reason}`);
        },
      },
      onRunCommitted: () => {
        operations.push("commit");
      },
    });
    agent.subscribe((event) => {
      if (event.type === "agent_end") {
        operations.push("publish");
      }
    });

    await agent.prompt("hi");

    expect(operations).toEqual([
      "start:user",
      "message:assistant",
      "end:stop",
      "commit",
      "publish",
    ]);
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("steers the active run at the next turn boundary and journals the input", async () => {
    const operations: string[] = [];
    const model = new TextModel("done");
    const agent = new Agent({
      model,
      journal: {
        startRun: ({ messages }) => {
          operations.push(`start:${messages.map((message) => message.role).join(",")}`);
        },
        appendMessage: ({ message }) => {
          operations.push(`message:${message.role}`);
        },
        appendCompaction: () => {},
        endRun: ({ reason }) => {
          operations.push(`end:${reason}`);
        },
      },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    const stream = agent.stream("Start.");
    const steeringInput = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Use the new direction.",
    };
    const steering = agent.steer(steeringInput);

    await stream.result();

    expect(await steering).toBe("consumed");
    expect(model.contexts).toHaveLength(2);
    expect(model.contexts[1]?.messages.at(-1)).toEqual(steeringInput);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(operations).toEqual([
      "start:user",
      "message:assistant",
      "message:user",
      "message:assistant",
      "end:stop",
    ]);
    expect(events.some((event) => event.type === "turn_input")).toBe(true);
  });

  test("defers steering input when no further turn is available", async () => {
    const agent = new Agent({
      model: new TextModel("done"),
      maxTurns: 1,
    });

    const stream = agent.stream("Start.");
    const steering = agent.steer({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Follow up.",
    });

    await stream.result();

    expect(await steering).toBe("deferred");
    expect(agent.state.messages).not.toContainEqual({ role: "user", content: "Follow up." });
  });

  test("does not replace the original steering waiter when a duplicate ID is rejected", async () => {
    const agent = new Agent({ model: new TextModel("done") });
    const stream = agent.stream("Start.");
    const input = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Same logical input.",
    };

    const first = agent.steer(input);
    await expect(agent.steer(input)).rejects.toThrow("already pending");
    await stream.result();

    expect(await first).toBe("consumed");
  });

  test("rejects a run input whose Message ID is still pending in the inbox", async () => {
    const model = new TextModel("unreachable");
    const agent = new Agent({ model });
    const input = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Pending input.",
    };
    agent.enqueueInput(input, "next-turn", { kind: "queued" });

    await expect(agent.prompt(input)).rejects.toThrow("Duplicate Message id");

    expect(model.contexts).toEqual([]);
    expect(agent.inbox.nextTurn.map((item) => item.message.id)).toEqual([input.id]);
  });

  test("rejects a model output ID that is already committed", async () => {
    const priorAssistant: AssistantMessage = {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Earlier output" }],
    };
    const agent = new Agent({
      model: new TextModel("Repeated output", undefined, priorAssistant),
      messages: [priorAssistant],
    });

    await expect(agent.prompt("Continue.")).rejects.toThrow("Duplicate Message id");
    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages[0]).toEqual(priorAssistant);
    expect(agent.state.messages[1]).toMatchObject({ role: "user", content: "Continue." });
    expect(agent.state.messages.filter((message) => message.id === priorAssistant.id)).toHaveLength(
      1,
    );
  });

  test("does not call the model when starting the journal fails", async () => {
    const model = new TextModel("unreachable");
    const error = new Error("session unavailable");
    const agent = new Agent({
      model,
      journal: {
        startRun: () => {
          throw error;
        },
        appendMessage: () => {},
        appendCompaction: () => {},
        endRun: () => {},
      },
    });

    await expect(agent.prompt("hi")).rejects.toBe(error);

    expect(model.contexts).toEqual([]);
    expect(agent.state.messages).toEqual([]);
  });

  test("commits context checkpoints with the run and exposes them in state", async () => {
    const model = new TextModel("after compact");
    const commits: Array<{ compactionCount: number; checkpointId?: string }> = [];
    const agent = new Agent({
      model,
      messages: [
        {
          ...messageIdentityForTest("user"),
          role: "user",
          content: "x".repeat(10_000),
        },
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Old answer" }],
        },
      ],
      context: {
        contextLimit: 4_000,
        maxOutputTokens: 500,
        compactPolicy: () => ({ summary: "Earlier exchange completed." }),
      },
      onRunCommitted: ({ compactions, state }) => {
        commits.push({
          compactionCount: compactions.length,
          checkpointId: state.contextCheckpoint?.id,
        });
      },
    });

    await agent.prompt("Continue");

    expect(commits).toHaveLength(1);
    expect(commits[0]?.compactionCount).toBe(1);
    expect(commits[0]?.checkpointId).toBe(agent.state.contextCheckpoint?.id);
    expect(agent.state.contextLimit).toBe(4_000);
    expect(model.contexts[0]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Earlier exchange completed."),
    });
    expect(model.contexts[0]?.maxOutputTokens).toBe(500);

    agent.reset();

    expect(agent.state.contextCheckpoint).toBeUndefined();
  });

  test("manually compacts without running the response model and reuses the checkpoint", async () => {
    const model = new TextModel("after manual compact");
    const events: AgentEvent["type"][] = [];
    const commits: Array<{ reason: string; checkpointId?: string }> = [];
    const agent = new Agent({
      model,
      messages: [
        { ...messageIdentityForTest("user"), role: "user", content: "x".repeat(8_000) },
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Old answer" }],
        },
      ],
      context: {
        contextLimit: 4_000,
        maxOutputTokens: 500,
        compactPolicy: () => ({ summary: "Earlier exchange completed." }),
      },
      onCompactionCommitted: ({ compaction, state }) => {
        commits.push({
          reason: compaction.reason,
          checkpointId: state.contextCheckpoint?.id,
        });
      },
    });
    agent.subscribe((event) => {
      events.push(event.type);
    });

    const checkpoint = await agent.compact();

    expect(checkpoint.reason).toBe("manual");
    expect(model.contexts).toHaveLength(0);
    expect(commits).toEqual([{ reason: "manual", checkpointId: checkpoint.id }]);
    expect(agent.state.contextCheckpoint?.id).toBe(checkpoint.id);
    expect(events).toEqual(["context_compaction_start", "context_compacted"]);

    await agent.prompt("Continue");

    expect(model.contexts).toHaveLength(1);
    expect(model.contexts[0]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Earlier exchange completed."),
    });
  });

  test("does not adopt a manual checkpoint when persistence fails", async () => {
    const agent = new Agent({
      model: new TextModel(),
      messages: [
        { ...messageIdentityForTest("user"), role: "user", content: "x".repeat(8_000) },
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Old answer" }],
        },
      ],
      context: {
        contextLimit: 4_000,
        maxOutputTokens: 500,
        compactPolicy: () => ({ summary: "Earlier exchange completed." }),
      },
      onCompactionCommitted: () => {
        throw new Error("persist failed");
      },
    });

    await expect(agent.compact()).rejects.toThrow("persist failed");

    expect(agent.state.contextCheckpoint).toBeUndefined();
  });

  test("returns state snapshots without exposing mutable message history", async () => {
    const agent = new Agent({
      model: new TextModel("hello"),
    });

    await agent.prompt("hi");

    const state = agent.state;
    state.messages.length = 0;

    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("deep-clones constructor messages before storing them", () => {
    const initialMessage = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "original",
    };
    const agent = new Agent({
      model: new TextModel(),
      messages: [initialMessage],
    });

    initialMessage.content = "mutated";

    expect(agent.state.messages).toEqual([{ ...initialMessage, content: "original" }]);
  });

  test("isolates listener mutations and failures from state and other listeners", async () => {
    const records: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (event, metadata) => records.push({ event, metadata }),
      error: () => {},
    };
    const agent = new Agent({
      model: new TextModel("committed"),
      logger,
    });
    let secondListenerMessageCount = 0;

    agent.subscribe((event) => {
      if (event.type === "agent_end") {
        event.messages.length = 0;
        throw new Error("observer failed");
      }
    });
    agent.subscribe((event) => {
      if (event.type === "agent_end") {
        secondListenerMessageCount = event.messages.length;
      }
    });

    await agent.prompt("hi");

    expect(secondListenerMessageCount).toBe(1);
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(records).toEqual([
      {
        event: "agent.listener_failed",
        metadata: {
          eventType: "agent_end",
          error: expect.any(Error),
        },
      },
    ]);
  });

  test("keeps commit inside the active run and publishes agent_end afterward", async () => {
    const commitStarted = deferred();
    const releaseCommit = deferred();
    const endEvents: AgentEvent[] = [];
    let isRunningDuringCommit = false;
    const agent = new Agent({
      model: new TextModel("committed"),
      onRunCommitted: async ({ state }) => {
        isRunningDuringCommit = state.isRunning;
        commitStarted.resolve();
        await releaseCommit.promise;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "agent_end") {
        endEvents.push(event);
      }
    });

    const stream = agent.stream("first");
    await commitStarted.promise;

    let idleSettled = false;
    const idle = agent.waitForIdle().then(() => {
      idleSettled = true;
    });
    await Promise.resolve();
    const isRunningBeforeRelease = agent.state.isRunning;
    const idleSettledBeforeRelease = idleSettled;
    const endEventCountBeforeRelease = endEvents.length;
    const concurrentResult = agent.stream("second").result();
    let resetError: unknown;
    try {
      agent.reset();
    } catch (error) {
      resetError = error;
    }

    releaseCommit.resolve();
    await stream.result();
    await idle;

    expect(isRunningDuringCommit).toBe(true);
    expect(isRunningBeforeRelease).toBe(true);
    expect(idleSettledBeforeRelease).toBe(false);
    expect(idleSettled).toBe(true);
    expect(endEventCountBeforeRelease).toBe(0);
    expect(endEvents).toHaveLength(1);
    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    await expect(concurrentResult).rejects.toThrow("Agent is already running.");
    expect(resetError).toBeInstanceOf(Error);
    expect((resetError as Error).message).toBe("Cannot reset Agent while it is running.");
  });

  test("does not publish agent_end when commit fails", async () => {
    const commitError = new Error("session append failed");
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model: new TextModel("uncommitted"),
      onRunCommitted: () => {
        throw commitError;
      },
    });
    agent.subscribe((event) => {
      events.push(event);
    });

    const stream = agent.stream("hi");

    await expect(stream.result()).rejects.toBe(commitError);
    await agent.waitForIdle();

    expect(events.some((event) => event.type === "agent_end")).toBe(false);
    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.error).toBe(commitError);
  });

  test("passes abort signal to the running model", async () => {
    const agent = new Agent({
      model: new AbortAwareModel(),
    });
    const stream = agent.stream("hi");
    const events: AgentEvent[] = [];

    for await (const event of stream) {
      events.push(event);

      if (event.type === "message_update") {
        agent.abort();
      }
    }

    const messages = await stream.result();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
    });
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      reason: "aborted",
    });
  });
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
}
