import {
  AssistantEventStream,
  AssistantMessageBuilder,
  BaseModel,
  type ModelConfig,
  type ModelContext,
  type ModelMetadata,
} from "@/core";

export type MockModelConfig = ModelConfig & {
  provider: "mock";
  response?: string;
};

const MOCK_MODEL_METADATA = {
  provider: "mock",
  model: "mock",
  protocol: null,
  contextWindow: 128_000,
  maxOutputTokens: 16_000,
  supportsParallelToolCalls: false,
  supportsHostedWebSearch: false,
  supportsImageInput: false,
} as const satisfies ModelMetadata;

export class MockModel extends BaseModel {
  readonly metadata = MOCK_MODEL_METADATA;

  constructor(private readonly config: MockModelConfig) {
    super();
  }

  stream(context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    // Match real providers: stream() returns before events start arriving.
    queueMicrotask(() => {
      const message = new AssistantMessageBuilder();
      if (context.signal?.aborted) {
        stream.error({
          type: "error",
          reason: "aborted",
          error: context.signal.reason,
          snapshot: message.snapshot(),
        });
        return;
      }

      const response = this.config.response ?? "Hello from mock.";
      stream.push({ type: "start", snapshot: message.snapshot() });
      const contentIndex = message.add({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, snapshot: message.snapshot() });
      if (response) {
        message.appendText(contentIndex, response);
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: response,
          snapshot: message.snapshot(),
        });
      }
      stream.push({
        type: "text_end",
        contentIndex,
        content: response,
        snapshot: message.snapshot(),
      });
      stream.end({ type: "done", reason: "stop", message: message.snapshot() });
    });

    return stream;
  }
}
