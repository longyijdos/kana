import { describe, expect, test } from "bun:test";
import {
  type CompactPolicyInput,
  ContextManager,
  createModelCompactPolicy,
  estimateContextTokens,
  estimateTextTokens,
  runAgentLoop,
} from "@/agent";
import {
  AssistantEventStream,
  type AssistantMessage,
  ContextWindowExceededError,
  createMessageIdentity,
  type Message,
  type Model,
  type ModelContext,
  type ModelMetadata,
} from "@/core";
import { messageIdentityForTest } from "../helpers/messages";

const MODEL_METADATA: ModelMetadata = {
  provider: "test",
  model: "context",
  contextWindow: 4_000,
  maxOutputTokens: 500,
  supportsParallelToolCalls: true,
  protocol: null,
  supportsHostedWebSearch: false,
};

describe("ContextManager", () => {
  test("computes prompt, trigger, and target budgets from the context limit", () => {
    const manager = new ContextManager({
      contextLimit: 128_000,
      maxOutputTokens: 384_000,
    });

    expect(manager.safetyReserve).toBe(6_400);
    expect(manager.promptBudget).toBe(121_600);
    expect(manager.triggerTokens).toBe(97_280);
    expect(manager.targetTokens).toBe(12_160);
  });

  test("treats configured output tokens as a per-request ceiling", async () => {
    const manager = new ContextManager({
      contextLimit: 4_000,
      maxOutputTokens: 5_000,
    });

    const prepared = await manager.prepareForModel({ messages: [] });

    expect(prepared.estimatedTokens).toBe(8);
    expect(prepared.context.maxOutputTokens).toBe(3_736);
  });

  test("selects the earliest complete boundary that retains the target-sized tail", async () => {
    let policyInput: CompactPolicyInput | undefined;
    const manager = new ContextManager({
      contextLimit: 4_000,
      maxOutputTokens: 500,
      targetRatio: 0.55,
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
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Old question",
      },
      {
        ...messageIdentityForTest("assistant"),
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
        ...messageIdentityForTest("user"),
        role: "user",
        content: "x".repeat(9_000),
      },
      {
        ...messageIdentityForTest("assistant"),
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
        ...messageIdentityForTest("tool"),
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
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Recent question",
      },
      {
        ...messageIdentityForTest("assistant"),
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
      id: messages[1]?.id,
      provenance: { kind: "model_output" },
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Old answer" }],
    });
    expect(policyInput?.messages[4]).toEqual({
      id: messages[4]?.id,
      provenance: { kind: "tool_result" },
      role: "tool",
      toolCallId: "call-1",
      toolName: "read",
      content: "model-visible result",
      isError: false,
    });
    expect(JSON.stringify(policyInput)).not.toContain("private chain of thought");
    expect(JSON.stringify(policyInput)).not.toContain("structured host result");
  });

  test("keeps runtime context out of summaries and reprojects covered snapshots", async () => {
    let policyInput: CompactPolicyInput | undefined;
    const manager = new ContextManager({
      contextLimit: 4_000,
      maxOutputTokens: 500,
      targetRatio: 0.55,
      compactPolicy: (input) => {
        policyInput = structuredClone(input);
        return { summary: "Earlier conversation." };
      },
    });
    const runtimeContext: Message = {
      ...createMessageIdentity({ kind: "runtime_context", source: "environment" }),
      role: "user",
      content: [
        '<runtime_context source="environment">',
        "current date: 2026-08-22",
        "</runtime_context>",
      ].join("\n"),
    };
    const messages: Message[] = [
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "x".repeat(9_000),
      },
      runtimeContext,
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Old answer" }],
      },
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Recent question",
      },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Recent answer" }],
      },
    ];

    const prepared = await manager.prepareForModel({ messages });

    expect(prepared.compaction).toMatchObject({
      coveredMessageCount: 3,
      compactedMessageCount: 3,
    });
    expect(policyInput?.messages).toEqual([messages[0], messages[2]]);
    expect(JSON.stringify(policyInput)).not.toContain("runtime_context");
    expect(prepared.context.messages).toEqual([
      expect.objectContaining({
        role: "user",
        provenance: { kind: "context_summary" },
        content: expect.stringContaining("Earlier conversation."),
      }),
      runtimeContext,
      ...messages.slice(3),
    ]);
  });

  test("defers threshold compaction when no complete turn is available", async () => {
    let policyCalls = 0;
    const manager = new ContextManager({
      contextLimit: 4_000,
      maxOutputTokens: 500,
      compactPolicy: () => {
        policyCalls += 1;
        return { summary: "unused" };
      },
    });
    const context = {
      messages: [
        {
          ...messageIdentityForTest("user"),
          role: "user" as const,
          content: "x".repeat(8_000),
        },
      ],
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
      maxOutputTokens: 500,
      compactPolicy: () => {
        policyCalls += 1;
        return { summary: "unused" };
      },
    });
    const context = {
      messages: [
        {
          ...messageIdentityForTest("user"),
          role: "user" as const,
          content: "x".repeat(8_000),
        },
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant" as const,
          stopReason: "toolUse" as const,
          content: [
            { type: "tool_call" as const, id: "call-1", name: "read", args: {} },
            { type: "tool_call" as const, id: "call-2", name: "read", args: {} },
          ],
        },
        {
          ...messageIdentityForTest("tool"),
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
      maxOutputTokens: 8_192,
    });
    const content = `${"A".repeat(48_000)}${"Z".repeat(12_000)}`;

    const limited = manager.limitToolContent(content);

    expect(manager.maxToolContentTokens).toBe(16_000);
    expect(estimateTextTokens(limited)).toBeLessThanOrEqual(manager.maxToolContentTokens);
    expect(limited.startsWith("A")).toBe(true);
    expect(limited.endsWith("Z")).toBe(true);
    expect(limited).toContain("[Tool output truncated for model context]");
  });

  test("estimates image patches without counting persisted base64 bytes", () => {
    const createContext = (data: string): ModelContext => ({
      messages: [
        {
          ...messageIdentityForTest("user"),
          role: "user",
          content: "",
          images: [
            {
              mimeType: "image/png",
              data,
              width: 33,
              height: 65,
            },
          ],
        },
      ],
    });

    expect(estimateContextTokens(createContext("small"))).toBe(20);
    expect(estimateContextTokens(createContext("x".repeat(100_000)))).toBe(20);
  });

  test("keeps a clean usage anchor when hosted tools inflate response input", async () => {
    let policyCalls = 0;
    const manager = new ContextManager({
      contextLimit: 100_000,
      maxOutputTokens: 10_000,
      compactPolicy: () => {
        policyCalls += 1;
        return { summary: "unused" };
      },
    });
    const messages: Message[] = [
      { ...messageIdentityForTest("user"), role: "user", content: "Hello" },
    ];
    const cleanResponse: AssistantMessage = {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "stop",
      usage: {
        promptTokens: 10_000,
        completionTokens: 10,
        totalTokens: 10_010,
      },
      content: [{ type: "text", text: "Hello back" }],
    };

    manager.recordAssistantUsage(cleanResponse, messages.length);
    messages.push(cleanResponse, {
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Search for Kana",
    });

    const hostedResponse: AssistantMessage = {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "stop",
      usage: {
        promptTokens: 90_000,
        completionTokens: 100,
        totalTokens: 90_100,
      },
      content: [
        {
          type: "hosted_tool",
          id: "search-1",
          name: "web_search",
          status: "completed",
          action: { type: "search", query: "Kana" },
        },
        { type: "text", text: "Search result" },
      ],
    };

    manager.recordAssistantUsage(hostedResponse, messages.length);
    messages.push(hostedResponse);

    const expectedAfterSearch =
      cleanResponse.usage!.promptTokens +
      estimateContextTokens({ messages: messages.slice(1) }) -
      8;
    expect(manager.estimateContextTokens({ messages })).toBe(expectedAfterSearch);
    expect(expectedAfterSearch).toBeLessThan(20_000);

    const prepared = await manager.prepareForModel({ messages });
    expect(prepared.compaction).toBeUndefined();
    expect(policyCalls).toBe(0);

    messages.push({ ...messageIdentityForTest("user"), role: "user", content: "Thanks" });
    const recalibratedResponse: AssistantMessage = {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "stop",
      usage: {
        promptTokens: 12_000,
        completionTokens: 5,
        totalTokens: 12_005,
      },
      content: [{ type: "text", text: "You're welcome" }],
    };
    manager.recordAssistantUsage(recalibratedResponse, messages.length);
    messages.push(recalibratedResponse);

    expect(manager.estimateContextTokens({ messages })).toBe(
      recalibratedResponse.usage!.promptTokens +
        estimateContextTokens({ messages: [recalibratedResponse] }) -
        8,
    );
  });

  test("restores the previous checkpoint when summary generation fails", async () => {
    const manager = new ContextManager({
      contextLimit: 4_000,
      maxOutputTokens: 500,
      compactPolicy: () => {
        throw new TypeError("secret provider response");
      },
    });

    await expect(
      manager.prepareForModel({
        messages: [
          { ...messageIdentityForTest("user"), role: "user", content: "x".repeat(10_000) },
          {
            ...messageIdentityForTest("assistant"),
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
  test("omits image bytes when the model cannot read images", async () => {
    let capturedContext: ModelContext | undefined;
    const model: Model = {
      metadata: {
        ...MODEL_METADATA,
        supportsImageInput: false,
      },
      stream() {
        throw new Error("stream should not be called directly");
      },
      async generate(context) {
        capturedContext = structuredClone(context);
        return {
          ...messageIdentityForTest("assistant"),
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
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Inspect the attached image.",
          images: [
            {
              mimeType: "image/png",
              data: "private-image-bytes",
              width: 64,
              height: 32,
            },
          ],
        },
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden history" },
            { type: "text", text: "Visible history" },
          ],
        },
        {
          ...messageIdentityForTest("tool"),
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
    expect(capturedContext?.maxOutputTokens).toBe(256);
    expect(capturedContext?.messages).toHaveLength(1);
    expect(JSON.stringify(capturedContext)).toContain("Previous state.");
    expect(JSON.stringify(capturedContext)).toContain("Visible history");
    expect(JSON.stringify(capturedContext)).toContain("visible tool content");
    const compactionRequest = capturedContext?.messages[0];
    expect(compactionRequest?.role).toBe("user");
    expect(compactionRequest?.role === "user" ? compactionRequest.content : "").toContain(
      '"contentOmitted":true',
    );
    expect(compactionRequest?.role === "user" ? compactionRequest.content : "").toContain(
      '"width":64',
    );
    expect(JSON.stringify(capturedContext)).not.toContain("private-image-bytes");
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

  test("attaches images when the model and configuration support them", async () => {
    let capturedContext: ModelContext | undefined;
    const model: Model = {
      metadata: {
        ...MODEL_METADATA,
        supportsImageInput: true,
      },
      stream() {
        throw new Error("stream should not be called directly");
      },
      async generate(context) {
        capturedContext = structuredClone(context);
        return {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Visual summary." }],
        };
      },
    };
    const policy = createModelCompactPolicy(model, { imageInputEnabled: true });

    const result = await policy({
      messages: [
        {
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Compare these images.",
          images: [
            {
              mimeType: "image/png",
              data: "first-image-bytes",
              width: 64,
              height: 32,
            },
          ],
        },
        {
          ...messageIdentityForTest("user"),
          role: "user",
          content: "And this one.",
          images: [
            {
              mimeType: "image/jpeg",
              data: "second-image-bytes",
              width: 16,
              height: 48,
            },
          ],
        },
      ],
      maxSummaryTokens: 256,
    });

    const compactionRequest = capturedContext?.messages[0];
    expect(compactionRequest?.role).toBe("user");
    if (compactionRequest?.role !== "user") {
      throw new Error("Expected a user compaction request.");
    }
    expect(compactionRequest.images).toEqual([
      {
        mimeType: "image/png",
        data: "first-image-bytes",
        width: 64,
        height: 32,
      },
      {
        mimeType: "image/jpeg",
        data: "second-image-bytes",
        width: 16,
        height: 48,
      },
    ]);
    expect(compactionRequest.content).toContain('"imageIndex":1');
    expect(compactionRequest.content).toContain('"imageIndex":2');
    expect(compactionRequest.content).not.toContain("contentOmitted");
    expect(compactionRequest.content).not.toContain("first-image-bytes");
    expect(compactionRequest.content).not.toContain("second-image-bytes");
    expect(result).toEqual({ summary: "Visual summary.", usage: undefined });
  });
});

describe("context-limit recovery", () => {
  test("forces one safe compaction and retries an empty failed request once", async () => {
    const model = new ContextLimitThenTextModel();
    const manager = new ContextManager({
      contextLimit: 4_000,
      maxOutputTokens: 500,
      compactPolicy: () => ({ summary: "Earlier exchange completed." }),
    });
    const events: string[] = [];

    const currentQuestion = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Current question",
    };
    const messages = await runAgentLoop(
      {
        messages: [
          { ...messageIdentityForTest("user"), role: "user", content: "Old question" },
          {
            ...messageIdentityForTest("assistant"),
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Old answer" }],
          },
          currentQuestion,
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
    expect(model.contexts[1]?.messages[0]).toMatchObject({
      role: "user",
      provenance: { kind: "context_summary" },
      content: expect.stringContaining("Earlier exchange completed."),
    });
    expect(model.contexts[1]?.messages[1]).toEqual(currentQuestion);
    expect(manager.compactions).toHaveLength(1);
    expect(manager.compactions[0]?.reason).toBe("provider_limit");
    expect(events.filter((event) => event === "context_compaction_start")).toHaveLength(1);
    expect(events.filter((event) => event === "context_compacted")).toHaveLength(1);
    expect(messages).toMatchObject([
      {
        role: "assistant",
        provenance: { kind: "model_output" },
        stopReason: "stop",
        content: [{ type: "text", text: "Recovered response" }],
      },
    ]);
    expect(messages[0]?.id).toBeDefined();
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
            ...messageIdentityForTest("assistant"),
            role: "assistant",
            content: [],
          },
        });
        return;
      }

      const message: AssistantMessage = {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        content: [{ type: "text", text: "Recovered response" }],
      };
      stream.push({
        type: "start",
        snapshot: { ...messageIdentityForTest("assistant"), role: "assistant", content: [] },
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
