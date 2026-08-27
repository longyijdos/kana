import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  ContextWindowExceededError,
  createMessageIdentity,
  type ModelContext,
} from "@/core";
import { isContextWindowFailure, readOpenAIErrorSignals } from "../context-window";
import { isProviderInactivityTimeout } from "../http";
import {
  createProviderDiagnostics,
  formatProviderFailure,
  type ProviderDiagnostics,
  type ProviderErrorCode,
  type ProviderRequestPhase,
} from "../lifecycle";
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
  private readonly diagnostics: ProviderDiagnostics;

  constructor(private readonly config: OpenAICompatibleModelConfig) {
    super();
    this.metadata = {
      ...config.metadata,
      provider: config.provider,
      model: config.model,
      protocol: "chat-completions" as const,
    };
    this.diagnostics = createProviderDiagnostics(config.logger, {
      provider: config.provider,
      model: config.model,
      protocol: "chat-completions",
    });
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
    let phase: ProviderRequestPhase = "validation";

    try {
      this.diagnostics.requestStarted();
      this.validateMaxOutputTokens(context);
      const requestSignal = createOpenAICompatibleRequestSignal(this.config, context.signal);
      try {
        phase = "request_build";
        const body = JSON.stringify(buildOpenAICompatibleRequest(context, this.config));
        phase = "http_request";
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
            body,
            signal: requestSignal.signal,
            // Redirects can forward authorization headers to a different
            // origin, so compatible endpoints must expose their final URL.
            redirect: "error",
          },
          this.config.maxRetries ?? 0,
          (details) => this.diagnostics.retrying(details),
        );
        requestSignal.refresh();
        stream.push({ type: "start", snapshot: structuredClone(message) });

        phase = "response_stream";
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
        this.diagnostics.requestCompleted(stopReason);
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      const normalized = normalizeProviderError(error, this.config.provider);
      this.diagnostics.requestFailed(
        formatProviderFailure(normalized, {
          phase,
          signal: context.signal,
          timedOut: isProviderInactivityTimeout(error),
          errorCode: getOpenAICompatibleErrorCode(error, normalized),
          ...(error instanceof OpenAICompatibleHttpError ? { httpStatus: error.status } : {}),
        }),
      );
      stream.error({
        type: "error",
        reason: isAbortError(normalized) || context.signal?.aborted ? "aborted" : "error",
        error: normalized,
        snapshot: structuredClone(message),
      });
    }
  }

  private validateMaxOutputTokens(context: ModelContext): void {
    const maxOutputTokens = context.maxOutputTokens ?? this.config.maxOutputTokens;
    if (
      (this.config.maxOutputTokens !== undefined &&
        this.config.maxOutputTokens > this.metadata.maxOutputTokens) ||
      (maxOutputTokens !== undefined && maxOutputTokens > this.metadata.maxOutputTokens)
    ) {
      throw new Error(
        `OpenAI-compatible model "${this.config.provider}/${this.config.model}" supports at most ${this.metadata.maxOutputTokens} output tokens.`,
      );
    }
  }
}

function normalizeProviderError(error: unknown, provider: string): unknown {
  if (!(error instanceof OpenAICompatibleHttpError) || !isOpenAIContextWindowFailure(error)) {
    return error;
  }
  return new ContextWindowExceededError(
    `${provider} rejected the request because its context window was exceeded.`,
    { cause: error },
  );
}

function isOpenAIContextWindowFailure(error: OpenAICompatibleHttpError): boolean {
  return isContextWindowFailure({
    status: error.status,
    ...readOpenAIErrorSignals(error.body),
  });
}

function getOpenAICompatibleErrorCode(
  error: unknown,
  normalized: unknown,
): ProviderErrorCode | undefined {
  if (normalized instanceof ContextWindowExceededError) {
    return "PROVIDER_CONTEXT_WINDOW_EXCEEDED";
  }
  if (error instanceof OpenAICompatibleHttpError) {
    return "PROVIDER_HTTP_ERROR";
  }
  return undefined;
}
