import type { ModelContext } from "../core/context";
import type { ModelOptions, ModelProvider } from "../core/model";
import type { AssistantMessage, TextContent } from "../core/messages";
import { AssistantMessageStream } from "../core/stream";
import { registerProvider } from "./registry";

export type MockModelOptions = ModelOptions & {
  response?: string;
};

export class MockModelProvider implements ModelProvider<MockModelOptions> {
  stream(
    _context: ModelContext,
    options: MockModelOptions = {},
  ): AssistantMessageStream {
    const stream = new AssistantMessageStream();

    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
      };

      if (options.signal?.aborted) {
        stream.error({
          type: "error",
          reason: "aborted",
          error: options.signal.reason,
          snapshot: structuredClone(message),
        });
        return;
      }

      const response = options.response ?? "Hello from mock.";
      const contentIndex = 0;

      stream.push({
        type: "start",
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

export const mockProvider = new MockModelProvider();

registerProvider("mock", mockProvider);
