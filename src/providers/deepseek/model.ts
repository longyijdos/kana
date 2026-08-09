import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  ContextWindowExceededError,
  type ModelContext,
  type ModelUsage,
} from "@/core";
import {
  ResponsesStreamProcessor,
  type ResponsesStreamState,
  readResponsesStream,
} from "../responses";
import {
  createRequestSignal,
  DeepSeekHttpError,
  fetchWithRetries,
  isAbortError,
  joinUrl,
} from "./http";
import { getDeepSeekModelMetadata } from "./metadata";
import { buildDeepSeekRequest } from "./request";
import { buildDeepSeekResponsesRequest } from "./responses-request";
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
    try {
      this.config.logger?.debug("provider.request_started", {
        provider: "deepseek",
        model: this.config.model,
        protocol: this.metadata.protocol,
      });
      const apiKey = this.config.apiKey ?? process.env.DEEPSEEK_API_KEY;

      if (!apiKey) {
        throw new Error(
          "DeepSeek API key is required. Pass config.apiKey or set DEEPSEEK_API_KEY.",
        );
      }

      const maxOutputTokens = context.maxOutputTokens ?? this.config.maxTokens;
      if (
        (this.config.maxTokens !== undefined &&
          this.config.maxTokens > this.metadata.maxOutputTokens) ||
        (maxOutputTokens !== undefined && maxOutputTokens > this.metadata.maxOutputTokens)
      ) {
        throw new Error(
          `DeepSeek model "${this.config.model}" supports at most ${this.metadata.maxOutputTokens} output tokens.`,
        );
      }

      const request =
        this.metadata.protocol === "responses"
          ? buildDeepSeekResponsesRequest(context, {
              ...this.config,
              webSearch: this.metadata.supportsHostedWebSearch && this.config.webSearch !== false,
            })
          : buildDeepSeekRequest(context, this.config);
      const requestSignal = createRequestSignal(this.config, context.signal);

      try {
        const response = await fetchWithRetries(
          joinUrl(
            this.config.baseUrl ?? DEFAULT_BASE_URL,
            this.metadata.protocol === "responses" ? "/responses" : "/chat/completions",
          ),
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
          (details) =>
            this.config.logger?.warn("provider.retrying", {
              provider: "deepseek",
              protocol: this.metadata.protocol,
              ...details,
            }),
        );
        requestSignal.refresh();

        stream.push({
          type: "start",
          snapshot: structuredClone(message),
        });

        const outcome =
          this.metadata.protocol === "responses"
            ? await this.consumeResponses(response, stream, message, requestSignal.refresh)
            : await this.consumeChatCompletions(response, stream, message, requestSignal.refresh);

        stream.end({
          type: "done",
          reason: outcome.stopReason,
          message: structuredClone(message),
          usage: outcome.usage,
        });
        this.config.logger?.debug("provider.request_ended", {
          provider: "deepseek",
          protocol: this.metadata.protocol,
          stopReason: outcome.stopReason,
        });
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      this.config.logger?.error("provider.request_failed", {
        provider: "deepseek",
        protocol: this.metadata.protocol,
        ...formatProviderFailure(error, context.signal),
      });
      stream.error({
        type: "error",
        reason: isAbortError(error) || context.signal?.aborted ? "aborted" : "error",
        error: normalizeDeepSeekError(error),
        snapshot: structuredClone(message),
      });
    }
  }

  private async consumeChatCompletions(
    response: Response,
    stream: AssistantEventStream,
    message: AssistantMessage,
    onActivity: () => void,
  ): Promise<DeepSeekStreamOutcome> {
    const state: DeepSeekStreamState = {
      endedContentIndexes: new Set<number>(),
    };
    await readDeepSeekStream(
      response,
      (chunk) => {
        applyDeepSeekChunk(stream, message, state, chunk);
      },
      onActivity,
    );

    finishOpenContent(stream, message, state);
    if (state.finishReason === "tool_calls") {
      finishToolCalls(stream, message, state);
    }
    return {
      stopReason: getDoneReason(state.finishReason),
      usage: state.usage,
    };
  }

  private async consumeResponses(
    response: Response,
    stream: AssistantEventStream,
    message: AssistantMessage,
    onActivity: () => void,
  ): Promise<DeepSeekStreamOutcome> {
    const state: ResponsesStreamState = {
      terminalSeen: false,
    };
    const processor = new ResponsesStreamProcessor(stream, message, state, {
      provider: "deepseek",
      providerLabel: "DeepSeek",
    });
    await readResponsesStream(response, (event) => processor.apply(event), "DeepSeek", onActivity);
    if (!state.terminalSeen || state.stopReason === undefined) {
      throw new Error("DeepSeek stream ended before a terminal response event.");
    }
    return {
      stopReason: state.stopReason,
      usage: state.usage,
    };
  }
}

type DeepSeekStreamOutcome = {
  stopReason: "stop" | "length" | "toolUse";
  usage?: ModelUsage;
};

function normalizeDeepSeekError(error: unknown): unknown {
  if (!(error instanceof DeepSeekHttpError) || !isContextWindowFailure(error)) {
    return error;
  }

  return new ContextWindowExceededError(
    "DeepSeek rejected the request because its context window was exceeded.",
    { cause: error },
  );
}

function isContextWindowFailure(error: DeepSeekHttpError): boolean {
  if (![400, 413, 422].includes(error.status)) {
    return false;
  }

  let code = "";
  let message = error.body;
  try {
    const parsed = JSON.parse(error.body) as {
      error?: {
        code?: unknown;
        message?: unknown;
      };
    };
    code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
    message = typeof parsed.error?.message === "string" ? parsed.error.message : message;
  } catch {
    // Some compatible endpoints return plain-text errors.
  }
  message = message.slice(0, 4_096);

  return (
    /context[_ -]?(length|window)[_ -]?exceeded/i.test(code) ||
    /(maximum|max).{0,32}context.{0,32}(length|window)|context.{0,32}(length|window).{0,32}(exceed|too (?:long|large))/i.test(
      message,
    ) ||
    /(?:input|prompt).{0,32}(?:token|length).{0,32}(?:exceed|too (?:long|large))/i.test(message)
  );
}

function formatProviderFailure(error: unknown, signal?: AbortSignal): Record<string, unknown> {
  const aborted = isAbortError(error) || signal?.aborted === true;

  if (error instanceof DeepSeekHttpError) {
    return {
      errorName: error.name,
      aborted,
      status: error.status,
      statusText: error.statusText,
    };
  }

  if (error instanceof Error) {
    return {
      errorName: error.name,
      aborted,
      ...(aborted ? {} : { message: error.message }),
    };
  }

  return { errorName: typeof error, aborted };
}
