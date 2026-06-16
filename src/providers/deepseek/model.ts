import { AssistantEventStream, type AssistantMessage, BaseModel, type ModelContext } from "@/core";
import { createRequestSignal, fetchWithRetries, isAbortError, joinUrl } from "./http";
import { getDeepSeekModelMetadata } from "./metadata";
import { buildDeepSeekRequest } from "./request";
import {
  applyDeepSeekChunk,
  finishOpenContent,
  finishToolCalls,
  getDoneReason,
  readDeepSeekStream,
} from "./stream";
import type { DeepSeekModelConfig, DeepSeekStreamState } from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export class DeepSeekModel extends BaseModel {
  readonly metadata;

  constructor(private readonly config: DeepSeekModelConfig) {
    super();
    this.metadata = getDeepSeekModelMetadata(config.model);
  }

  stream(context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    // The model contract is synchronous: return the stream immediately and let
    // the request lifecycle write events into it asynchronously.
    void this.run(stream, context);

    return stream;
  }

  private async run(stream: AssistantEventStream, context: ModelContext): Promise<void> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
    };
    const state: DeepSeekStreamState = {
      endedContentIndexes: new Set<number>(),
    };

    try {
      const apiKey = this.config.apiKey ?? process.env.DEEPSEEK_API_KEY;

      if (!apiKey) {
        throw new Error(
          "DeepSeek API key is required. Pass config.apiKey or set DEEPSEEK_API_KEY.",
        );
      }

      if (
        this.config.maxTokens !== undefined &&
        this.config.maxTokens > this.metadata.maxOutputTokens
      ) {
        throw new Error(
          `DeepSeek model "${this.config.model}" supports at most ${this.metadata.maxOutputTokens} output tokens.`,
        );
      }

      const request = buildDeepSeekRequest(context, this.config);
      const requestSignal = createRequestSignal(this.config, context.signal);

      try {
        const response = await fetchWithRetries(
          joinUrl(this.config.baseUrl ?? DEFAULT_BASE_URL, "/chat/completions"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              authorization: `Bearer ${apiKey}`,
              ...this.config.headers,
            },
            body: JSON.stringify(request),
            signal: requestSignal.signal,
          },
          this.config.maxRetries ?? 0,
        );

        stream.push({
          type: "start",
          snapshot: structuredClone(message),
        });

        await readDeepSeekStream(response, (chunk) => {
          applyDeepSeekChunk(stream, message, state, chunk);
        });

        finishOpenContent(stream, message, state);

        if (state.finishReason === "tool_calls") {
          finishToolCalls(stream, message, state);
        }

        stream.end({
          type: "done",
          reason: getDoneReason(state.finishReason),
          message: structuredClone(message),
        });
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      stream.error({
        type: "error",
        reason: isAbortError(error) || context.signal?.aborted ? "aborted" : "error",
        error,
        snapshot: structuredClone(message),
      });
    }
  }
}
