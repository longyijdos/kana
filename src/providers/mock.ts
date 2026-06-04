import type { ModelContext } from "../core/context";
import {
  BaseModel,
  type ModelMetadata,
  type ModelConfig,
} from "../core/model";
import type { AssistantMessage, TextContent } from "../core/messages";
import { AssistantEventStream } from "../core/stream";

export type MockModelConfig = ModelConfig & {
  provider: "mock";
  response?: string;
};

export const MOCK_MODEL_METADATA = {
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxOutputTokens: 16_000,
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
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
      };

      const signal = context.signal;

      if (signal?.aborted) {
        stream.error({
          type: "error",
          reason: "aborted",
          error: signal.reason,
          snapshot: structuredClone(message),
        });
        return;
      }

      const response = this.config.response ?? "Hello from mock.";
      const contentIndex = 0;

      stream.push({
        type: "start",
        // Snapshots must not share the mutable message object used below.
        snapshot: structuredClone(message),
      });

      const textContent: TextContent = {
        type: "text",
        text: "",
      };

      message.content.push(textContent);

      stream.push({
        type: "text_start",
        contentIndex,
        snapshot: structuredClone(message),
      });

      if (response) {
        textContent.text = response;

        stream.push({
          type: "text_delta",
          contentIndex,
          delta: response,
          snapshot: structuredClone(message),
        });
      }

      stream.push({
        type: "text_end",
        contentIndex,
        content: response,
        snapshot: structuredClone(message),
      });

      stream.end({
        type: "done",
        reason: "stop",
        message: structuredClone(message),
      });
    });

    return stream;
  }
}
