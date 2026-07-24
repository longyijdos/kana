import { describe, expect, test } from "bun:test";
import {
  type CompactPolicyInput,
  ContextManager,
  createModelCompactPolicy,
  estimateTextTokens,
  runAgentLoop,
} from "@/agent";
import {
  AssistantEventStream,
  type AssistantMessage,
  ContextWindowExceededError,
  type Message,
  type Model,
  type ModelContext,
  type ModelMetadata,
} from "@/core";

const MODEL_METADATA: ModelMetadata = {
  provider: "test",
  model: "context",
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 4_000,
  maxOutputTokens: 500,
};

describe("ContextManager", () => {
  test("computes prompt, trigger, and target budgets from the context limit", () => {
    const manager = new ContextManager({
      contextLimit: 128_000,
      outputReserve: 8_192,
    });

    expect(manager.safetyReserve).toBe(6_400);
    expect(manager.promptBudget).toBe(113_408);
    expect(manager.triggerTokens).toBe(90_726);
    expect(manager.targetTokens).toBe(62_374);
  });

  test("selects the earliest complete boundary that retains the target-sized tail", async () => {
    let policyInput: CompactPolicyInput | undefined;
    const manager = new ContextManager({
      contextLimit: 4_000,
      outputReserve: 500,
      compactPolicy: (input) => {
        policyInput = structuredClone(input);
        return {
          summary: "The older work is complete.",
          usage: {
            promptTokens: 1_000,
            completionTokens: 100,
            totalTokens: 1_100,
          },
        };
      },
    });
    const messages: Message[] = [
      {
        role: "user",
        content: "Old question",
      },
      {
        role: "assistant",
        stopReason: "stop",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
        content: [
          { type: "thinking", text: "private chain of thought" },
          { type: "text", text: "Old answer" },
        ],
      },
      {
        role: "user",
        content: "x".repeat(9_000),
      },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "read",
            args: { path: "large.txt" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "read",
        content: "model-visible result",
        result: {
          content: "structured host result",
        },
        isError: false,
      },
      {
        role: "user",
        content: "Recent question",
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Recent answer" }],
      },
    ];

    const prepared = await manager.prepareForModel({ messages });

    expect(prepared.compaction).toMatchObject({
      reason: "threshold",
      coveredMessageCount: 5,
      compactedMessageCount: 5,
    });
    expect(prepared.context.messages).toHaveLength(3);
    expect(prepared.context.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("The older work is complete."),
    });
    expect(prepared.context.messages.slice(1)).toEqual(messages.slice(5));

    expect(policyInput?.messages).toHaveLength(5);
    expect(policyInput?.messages[1]).toEqual({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Old answer" }],
    });
    expect(policyInput?.messages[4]).toEqual({
      role: "tool",
      toolCallId: "call-1",
      toolName: "read",
      content: "model-visible result",
      isError: false,
    });
    expect(JSON.stringify(policyInput)).not.toContain("private chain of thought");
    expect(JSON.stringify(policyInput)).not.toContain("structured host result");
  });

  test("defers threshold compaction when no complete turn is available", async () => {
    let policyCalls = 0;
    const manager = new ContextManager({
      contextLimit: 4_000,
      outputReserve: 500,
      compactPolicy: () => {
        policyCalls += 1;
        return { summary: "unused" };
      },
    });
    const context = {
      messages: [{ role: "user" as const, content: "x".repeat(8_000) }],
    };

    const prepared = await manager.prepareForModel(context);

    expect(prepared.compaction).toBeUndefined();
    expect(prepared.context.messages).toEqual(context.messages);
    expect(policyCalls).toBe(0);
    await expect(
      manager.prepareForModel(context, {
        forceCompaction: true,
      }),
    ).rejects.toThrow("Context cannot be compacted without splitting an incomplete turn.");
  });

  test("never cuts between a multi-tool call and its remaining results", async () => {
    let policyCalls = 0;
    const manager = new ContextManager({
      contextLimit: 4_000,
      outputReserve: 500,
      compactPolicy: () => {
        policyCalls += 1;
        return { summary: "unused" };
      },
    });
    const context = {
      messages: [
        { role: "user" as const, content: "x".repeat(8_000) },
        {
          role: "assistant" as const,
          stopReason: "toolUse" as const,
          content: [
            { type: "tool_call" as const, id: "call-1", name: "read", args: {} },
            { type: "tool_call" as const, id: "call-2", name: "read", args: {} },
          ],
        },
        {
          role: "tool" as const,
          toolCallId: "call-1",
          toolName: "read",
          content: "first result",
          isError: false,
        },
      ],
    };

    const prepared = await manager.prepareForModel(context);

    expect(prepared.compaction).toBeUndefined();
    expect(policyCalls).toBe(0);
  });

  test("bounds model-visible tool content while retaining the structured result elsewhere", () => {
    const manager = new ContextManager({
      contextLimit: 128_000,
      outputReserve: 8_192,
    });
    const content = `${"A".repeat(48_000)}${"Z".repeat(12_000)}`;

    const limited = manager.limitToolContent(content);

    expect(manager.maxToolContentTokens).toBe(16_000);
    expect(estimateTextTokens(limited)).toBeLessThanOrEqual(manager.maxToolContentTokens);
    expect(limited.startsWith("A")).toBe(true);
    expect(limited.endsWith("Z")).toBe(true);
    expect(limited).toContain("[Tool output truncated for model context]");
  });

  test("restores the previous checkpoint when summary generation fails", async () => {
    const manager = new ContextManager({
      contextLimit: 4_000,
      outputReserve: 500,
      compactPolicy: () => {
        throw new TypeError("secret provider response");
      },
    });

    await expect(
      manager.prepareForModel({
        messages: [
          { role: "user", content: "x".repeat(8_000) },
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "done" }],
          },
        ],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ContextCompactionError",
        message: "Context compaction failed (TypeError).",
      }),
    );
    expect(manager.checkpoint).toBeUndefined();
  });
});

describe("model compaction policy", () => {
  test("uses one tool-free model request and extracts only visible text", async () => {
    let capturedContext: ModelContext | undefined;
    const model: Model = {
      metadata: MODEL_METADATA,
      stream() {
        throw new Error("stream should not be called directly");
      },
      async generate(context) {
        capturedContext = structuredClone(context);
        return {
          role: "assistant",
          stopReason: "stop",
          usage: {
            promptTokens: 200,
            completionTokens: 20,
            totalTokens: 220,
          },
          content: [
            { type: "thinking", text: "summary reasoning" },
            { type: "text", text: "Concise summary." },
          ],
        };
      },
    };
    const policy = createModelCompactPolicy(model);

    const result = await policy({
      previousSummary: "Previous state.",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden history" },
            { type: "text", text: "Visible history" },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "read",
          content: "visible tool content",
          result: { secret: "structured result" },
          isError: false,
        },
      ],
      maxSummaryTokens: 256,
    });

    expect(capturedContext?.tools).toBeUndefined();
    expect(capturedContext?.messages).toHaveLength(1);
    expect(JSON.stringify(capturedContext)).toContain("Previous state.");
    expect(JSON.stringify(capturedContext)).toContain("Visible history");
    expect(JSON.stringify(capturedContext)).toContain("visible tool content");
    expect(JSON.stringify(capturedContext)).not.toContain("hidden history");
    expect(JSON.stringify(capturedContext)).not.toContain("structured result");
    expect(result).toEqual({
      summary: "Concise summary.",
      usage: {
        promptTokens: 200,
        completionTokens: 20,
        totalTokens: 220,
      },
    });
  });
});

describe("context-limit recovery", () => {
  test("forces one safe compaction and retries an empty failed request once", async () => {
    const model = new ContextLimitThenTextModel();
    const manager = new ContextManager({
      contextLimit: 4_000,
      outputReserve: 500,
      compactPolicy: () => ({ summary: "Earlier exchange completed." }),
    });
    const events: string[] = [];

    const messages = await runAgentLoop(
      {
        messages: [
          { role: "user", content: "Old question" },
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Old answer" }],
          },
          { role: "user", content: "Current question" },
        ],
      },
      {
        model,
        contextManager: manager,
      },
      (event) => {
        events.push(event.type);
      },
    );

    expect(model.contexts).toHaveLength(2);
    expect(model.contexts[0]?.messages).toHaveLength(3);
    expect(model.contexts[1]?.messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("Earlier exchange completed."),
      },
      {
        role: "user",
        content: "Current question",
      },
    ]);
    expect(manager.compactions).toHaveLength(1);
    expect(manager.compactions[0]?.reason).toBe("provider_limit");
    expect(events.filter((event) => event === "context_compaction_start")).toHaveLength(1);
    expect(events.filter((event) => event === "context_compacted")).toHaveLength(1);
    expect(messages).toEqual([
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Recovered response" }],
      },
    ]);
  });
});

class ContextLimitThenTextModel implements Model {
  readonly metadata = MODEL_METADATA;
  readonly contexts: ModelContext[] = [];

  stream(context: ModelContext): AssistantEventStream {
    this.contexts.push(structuredClone(context));
    const stream = new AssistantEventStream();
    const attempt = this.contexts.length;

    queueMicrotask(() => {
      if (attempt === 1) {
        stream.error({
          type: "error",
          reason: "error",
          error: new ContextWindowExceededError(),
          snapshot: {
            role: "assistant",
            content: [],
          },
        });
        return;
      }

      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Recovered response" }],
      };
      stream.push({
        type: "start",
        snapshot: { role: "assistant", content: [] },
      });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        snapshot: structuredClone(message),
      });
      stream.end({
        type: "done",
        reason: "stop",
        message,
      });
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}
