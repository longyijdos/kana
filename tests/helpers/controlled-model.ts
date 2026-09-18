import {
  type AssistantContent,
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  createMessageIdentity,
  type ModelContext,
} from "../../src/core";

type ControlledRequest = {
  context: ModelContext;
  update(text: string): void;
  complete(content: string | AssistantContent[], reason?: "stop" | "toolUse" | "length"): void;
  fail(): void;
};

export class ControlledModel extends BaseModel {
  readonly metadata = {
    provider: "test",
    model: "controlled",
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    protocol: null,
    supportsParallelToolCalls: true,
    supportsHostedWebSearch: true,
    supportsImageInput: true,
  };
  readonly requests: ControlledRequest[] = [];

  stream(context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();
    const message: AssistantMessage = {
      ...createMessageIdentity({ kind: "model_output" }),
      role: "assistant",
      content: [],
    };
    const fail = (reason: "error" | "aborted"): void => {
      context.signal?.removeEventListener("abort", abort);
      stream.error({
        type: "error",
        reason,
        error: new Error(reason),
        snapshot: structuredClone(message),
      });
    };
    const abort = (): void => fail("aborted");
    context.signal?.addEventListener("abort", abort, { once: true });
    stream.push({ type: "start", snapshot: structuredClone(message) });
    this.requests.push({
      context: { ...context, messages: structuredClone(context.messages) },
      update: (text) => {
        const first = message.content.length === 0;
        message.content = [{ type: "text", text }];
        if (first) {
          stream.push({ type: "text_start", contentIndex: 0, snapshot: structuredClone(message) });
        }
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          snapshot: structuredClone(message),
        });
      },
      complete: (content, reason = "stop") => {
        context.signal?.removeEventListener("abort", abort);
        message.content = typeof content === "string" ? [{ type: "text", text: content }] : content;
        stream.end({ type: "done", reason, message: structuredClone(message) });
      },
      fail: () => fail("error"),
    });
    if (context.signal?.aborted) {
      abort();
    }
    return stream;
  }
}
