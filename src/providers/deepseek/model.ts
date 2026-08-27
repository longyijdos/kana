import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  ContextWindowExceededError,
  createMessageIdentity,
  type HostedToolAction,
  type ModelContext,
  type ModelUsage,
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
  ResponsesStreamError,
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
import type { DeepSeekModelConfig } from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export class DeepSeekModel extends BaseModel {
  readonly metadata;
  private readonly diagnostics: ProviderDiagnostics;

  constructor(private readonly config: DeepSeekModelConfig) {
    super();
    this.metadata = getDeepSeekModelMetadata(config.model);
    this.diagnostics = createProviderDiagnostics(config.logger, {
      provider: "deepseek",
      model: config.model,
      protocol: this.metadata.protocol,
    });
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
      ...createMessageIdentity({ kind: "model_output" }),
      role: "assistant",
      content: [],
    };
    let phase: ProviderRequestPhase = "validation";
    try {
      this.diagnostics.requestStarted();
      phase = "authentication";
      const apiKey = this.config.apiKey ?? process.env.DEEPSEEK_API_KEY;

      if (!apiKey) {
        throw new Error(
          "DeepSeek API key is required. Pass config.apiKey or set DEEPSEEK_API_KEY.",
        );
      }

      phase = "validation";
      const maxOutputTokens = context.maxOutputTokens ?? this.config.maxOutputTokens;
      if (
        (this.config.maxOutputTokens !== undefined &&
          this.config.maxOutputTokens > this.metadata.maxOutputTokens) ||
        (maxOutputTokens !== undefined && maxOutputTokens > this.metadata.maxOutputTokens)
      ) {
        throw new Error(
          `DeepSeek model "${this.config.model}" supports at most ${this.metadata.maxOutputTokens} output tokens.`,
        );
      }

      phase = "request_build";
      const request = buildDeepSeekRequest(
        {
          ...context,
          webSearch: context.webSearch === true && this.metadata.supportsHostedWebSearch,
          imageInput: context.imageInput === true && this.metadata.supportsImageInput === true,
        },
        this.config,
      );
      phase = "http_request";
      const requestSignal = createRequestSignal(this.config, context.signal);

      try {
        phase = "request_build";
        const body = JSON.stringify(request);
        phase = "http_request";
        const response = await fetchWithRetries(
          joinUrl(this.config.baseUrl ?? DEFAULT_BASE_URL, "/responses"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              authorization: `Bearer ${apiKey}`,
              ...this.config.headers,
            },
            body,
            signal: requestSignal.signal,
          },
          this.config.maxRetries ?? 0,
          (details) => this.diagnostics.retrying(details),
        );
        requestSignal.refresh();

        stream.push({
          type: "start",
          snapshot: structuredClone(message),
        });

        phase = "response_stream";
        const outcome = await this.consumeResponses(
          response,
          stream,
          message,
          requestSignal.refresh,
        );

        stream.end({
          type: "done",
          reason: outcome.stopReason,
          message: structuredClone(message),
          usage: outcome.usage,
        });
        this.diagnostics.requestCompleted(outcome.stopReason);
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      const normalized = normalizeDeepSeekError(error);
      this.diagnostics.requestFailed(
        formatProviderFailure(normalized, {
          phase,
          signal: context.signal,
          timedOut: isProviderInactivityTimeout(error),
          errorCode: getDeepSeekErrorCode(error, normalized),
          ...(error instanceof DeepSeekHttpError ? { httpStatus: error.status } : {}),
          ...(error instanceof ResponsesStreamError
            ? {
                eventType: error.eventType,
                ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
              }
            : {}),
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
      normalizeHostedToolAction: normalizeDeepSeekHostedToolAction,
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

function normalizeDeepSeekHostedToolAction(
  action: HostedToolAction,
  item: Readonly<Record<string, unknown>>,
): HostedToolAction {
  const itemId = typeof item.id === "string" ? item.id : undefined;
  if (itemId === undefined) {
    return action;
  }

  // DeepSeek appends its replay correlation marker to user-facing queries and
  // URL fragments. Keep it in providerState, but not in the semantic action.
  const marker = `ws_call_id=${itemId}`;
  const normalized = structuredClone(action);
  if (normalized.query === marker) {
    delete normalized.query;
  }
  if (normalized.queries !== undefined) {
    const queries = normalized.queries.filter((query) => query !== marker);
    if (queries.length > 0) {
      normalized.queries = queries;
    } else {
      delete normalized.queries;
    }
  }
  if (normalized.url?.endsWith(`#${marker}`)) {
    normalized.url = normalized.url.slice(0, -(marker.length + 1));
  }
  return normalized;
}

function normalizeDeepSeekError(error: unknown): unknown {
  if (!(error instanceof DeepSeekHttpError) || !isDeepSeekContextWindowFailure(error)) {
    return error;
  }

  return new ContextWindowExceededError(
    "DeepSeek rejected the request because its context window was exceeded.",
    { cause: error },
  );
}

function isDeepSeekContextWindowFailure(error: DeepSeekHttpError): boolean {
  return isContextWindowFailure({
    status: error.status,
    ...readOpenAIErrorSignals(error.body),
  });
}

function getDeepSeekErrorCode(error: unknown, normalized: unknown): ProviderErrorCode | undefined {
  if (normalized instanceof ContextWindowExceededError) {
    return "PROVIDER_CONTEXT_WINDOW_EXCEEDED";
  }
  if (error instanceof DeepSeekHttpError) {
    return "PROVIDER_HTTP_ERROR";
  }
  if (error instanceof ResponsesStreamError) {
    return error.retryable ? "PROVIDER_STREAM_TRANSIENT_ERROR" : "PROVIDER_STREAM_ERROR";
  }
  return undefined;
}
