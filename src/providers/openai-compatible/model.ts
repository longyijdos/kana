import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  ContextWindowExceededError,
  createMessageIdentity,
  type ModelContext,
} from "@/core";
import {
  createOpenAICompatibleRequestSignal,
  fetchOpenAICompatibleWithRetries,
  isAbortError,
  OpenAICompatibleHttpError,
  resolveOpenAICompatibleUrl,
} from "./http";
import { buildOpenAICompatibleRequest } from "./request";
import {
  applyOpenAICompatibleChunk,
  finishOpenAICompatibleContent,
  finishOpenAICompatibleToolCalls,
  getOpenAICompatibleDoneReason,
  readOpenAICompatibleStream,
} from "./stream";
import type { OpenAICompatibleModelConfig, OpenAICompatibleStreamState } from "./types";

export class OpenAICompatibleModel extends BaseModel {
  readonly metadata;

  constructor(private readonly config: OpenAICompatibleModelConfig) {
    super();
    this.metadata = {
      ...config.metadata,
      provider: config.provider,
      model: config.model,
      protocol: "chat-completions" as const,
    };
  }

  stream(context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();
    void this.run(stream, context);
    return stream;
  }

  private async run(stream: AssistantEventStream, context: ModelContext): Promise<void> {
    const message: AssistantMessage = {
      ...createMessageIdentity({ kind: "model_output" }),
      role: "assistant",
      content: [],
    };

    try {
      this.config.logger?.debug("provider.request_started", this.logMetadata());
      this.validateMaxOutputTokens(context);
      const requestSignal = createOpenAICompatibleRequestSignal(this.config, context.signal);
      try {
        const response = await fetchOpenAICompatibleWithRetries(
          resolveOpenAICompatibleUrl(this.config.baseUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...this.config.headers,
              ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
            },
            body: JSON.stringify(buildOpenAICompatibleRequest(context, this.config)),
            signal: requestSignal.signal,
            // Redirects can forward authorization headers to a different
            // origin, so compatible endpoints must expose their final URL.
            redirect: "error",
          },
          this.config.maxRetries ?? 0,
          (details) =>
            this.config.logger?.warn("provider.retrying", {
              ...this.logMetadata(),
              ...details,
            }),
        );
        requestSignal.refresh();
        stream.push({ type: "start", snapshot: structuredClone(message) });

        const state: OpenAICompatibleStreamState = {
          endedContentIndexes: new Set<number>(),
        };
        await readOpenAICompatibleStream(
          response,
          (chunk) => applyOpenAICompatibleChunk(stream, message, state, chunk),
          requestSignal.refresh,
        );
        finishOpenAICompatibleContent(stream, message, state);
        const hasToolCalls = message.content.some((content) => content.type === "tool_call");
        const finishReason = state.finishReason ?? (hasToolCalls ? "tool_calls" : undefined);
        if (finishReason === "tool_calls") {
          if (!hasToolCalls) {
            throw new Error(
              "OpenAI-compatible provider finished with tool_calls but returned no tool call.",
            );
          }
          finishOpenAICompatibleToolCalls(stream, message, state);
        } else if (hasToolCalls) {
          throw new Error(
            `OpenAI-compatible provider returned tool calls with finish reason ${finishReason}.`,
          );
        }
        const stopReason = getOpenAICompatibleDoneReason(finishReason);
        stream.end({
          type: "done",
          reason: stopReason,
          message: structuredClone(message),
          usage: state.usage,
        });
        this.config.logger?.debug("provider.request_ended", {
          ...this.logMetadata(),
          stopReason,
        });
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      this.config.logger?.error("provider.request_failed", {
        ...this.logMetadata(),
        ...formatProviderFailure(error, context.signal),
      });
      stream.error({
        type: "error",
        reason: isAbortError(error) || context.signal?.aborted ? "aborted" : "error",
        error: normalizeProviderError(error, this.config.provider),
        snapshot: structuredClone(message),
      });
    }
  }

  private validateMaxOutputTokens(context: ModelContext): void {
    const maxOutputTokens = context.maxOutputTokens ?? this.config.maxTokens;
    if (
      (this.config.maxTokens !== undefined &&
        this.config.maxTokens > this.metadata.maxOutputTokens) ||
      (maxOutputTokens !== undefined && maxOutputTokens > this.metadata.maxOutputTokens)
    ) {
      throw new Error(
        `OpenAI-compatible model "${this.config.provider}/${this.config.model}" supports at most ${this.metadata.maxOutputTokens} output tokens.`,
      );
    }
  }

  private logMetadata(): Record<string, unknown> {
    return {
      provider: this.config.provider,
      model: this.config.model,
      protocol: "chat-completions",
    };
  }
}

function normalizeProviderError(error: unknown, provider: string): unknown {
  if (!(error instanceof OpenAICompatibleHttpError) || !isContextWindowFailure(error)) {
    return error;
  }
  return new ContextWindowExceededError(
    `${provider} rejected the request because its context window was exceeded.`,
    { cause: error },
  );
}

function isContextWindowFailure(error: OpenAICompatibleHttpError): boolean {
  if (![400, 413, 422].includes(error.status)) {
    return false;
  }

  let code = "";
  let message = error.body;
  try {
    const parsed = JSON.parse(error.body) as {
      error?: { code?: unknown; message?: unknown };
    };
    code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
    message = typeof parsed.error?.message === "string" ? parsed.error.message : message;
  } catch {
    // OpenAI-compatible endpoints may return plain-text errors.
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
  if (error instanceof OpenAICompatibleHttpError) {
    return {
      errorCode: "OPENAI_COMPATIBLE_HTTP_ERROR",
      errorType: error.name,
      aborted,
      status: error.status,
      statusText: error.statusText,
    };
  }
  return {
    errorCode: aborted ? "OPENAI_COMPATIBLE_ABORTED" : "OPENAI_COMPATIBLE_REQUEST_ERROR",
    errorType: error instanceof Error ? error.name : typeof error,
    aborted,
  };
}
