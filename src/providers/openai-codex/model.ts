import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  ContextWindowExceededError,
  createMessageIdentity,
  type ModelContext,
} from "@/core";
import { isRetryableResponsesStreamError, ResponsesStreamError } from "../responses";
import {
  createOpenAICodexRequestSignal,
  getOpenAICodexRetryDelayMs,
  isAbortError,
  isOpenAICodexRetryable,
  OpenAICodexHttpError,
  resolveOpenAICodexUrl,
  sleepForOpenAICodexRetry,
} from "./http";
import { getOpenAICodexModelMetadata } from "./metadata";
import { buildOpenAICodexRequest } from "./request";
import { OpenAICodexStreamProcessor, readOpenAICodexStream } from "./stream";
import type {
  OpenAICodexCredentials,
  OpenAICodexModelConfig,
  OpenAICodexStreamState,
} from "./types";

type OpenAICodexRetryState = {
  credentials: OpenAICodexCredentials;
  authRefreshed: boolean;
  attempt: number;
};

export class OpenAICodexModel extends BaseModel {
  readonly metadata;

  constructor(private readonly config: OpenAICodexModelConfig) {
    super();
    this.metadata = getOpenAICodexModelMetadata(config.model);
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
      this.config.logger?.debug("provider.request_started", {
        provider: "openai-codex",
        model: this.config.model,
      });
      if (
        this.config.maxTokens !== undefined &&
        this.config.maxTokens > this.metadata.maxOutputTokens
      ) {
        throw new Error(
          `OpenAI Codex model "${this.config.model}" supports at most ${this.metadata.maxOutputTokens} output tokens.`,
        );
      }

      const credentials = await this.config.credentialProvider.getCredentials();
      if (credentials === undefined) {
        throw new Error(
          "OpenAI Codex is not authorized. Run `kana auth login openai-codex` first.",
        );
      }

      const maxRetries = this.config.maxRetries ?? 0;
      const retryState: OpenAICodexRetryState = {
        credentials,
        authRefreshed: false,
        attempt: 0,
      };
      const body = JSON.stringify(
        buildOpenAICodexRequest(
          {
            ...context,
            parallelToolCalls:
              context.parallelToolCalls === true && this.metadata.supportsParallelToolCalls,
          },
          this.config,
        ),
      );
      const requestSignal = createOpenAICodexRequestSignal(this.config, context.signal);
      try {
        let started = false;
        let completedState: OpenAICodexStreamState | undefined;

        for (;;) {
          const response = await this.request(body, retryState, requestSignal.signal);
          requestSignal.refresh();
          if (!started) {
            stream.push({
              type: "start",
              snapshot: structuredClone(message),
            });
            started = true;
          }

          const attemptState: OpenAICodexStreamState = {
            terminalSeen: false,
          };
          const processor = new OpenAICodexStreamProcessor(stream, message, attemptState);
          try {
            await readOpenAICodexStream(
              response,
              (event) => processor.apply(event),
              requestSignal.refresh,
            );
            if (!attemptState.terminalSeen || attemptState.stopReason === undefined) {
              throw new Error("OpenAI Codex stream ended before a terminal response event.");
            }
            completedState = attemptState;
            break;
          } catch (error) {
            if (
              !isRetryableResponsesStreamError(error) ||
              processor.hasStartedOutput ||
              retryState.attempt >= maxRetries
            ) {
              throw error;
            }

            const delayMs = getOpenAICodexRetryDelayMs(retryState.attempt, response);
            retryState.attempt += 1;
            this.config.logger?.warn("provider.retrying", {
              provider: "openai-codex",
              phase: "responses_stream",
              attempt: retryState.attempt,
              delayMs,
              errorCode: "RESPONSES_STREAM_TRANSIENT",
              eventType: error.eventType,
            });
            await sleepForOpenAICodexRetry(delayMs, requestSignal.signal);
          }
        }

        const state = completedState;
        if (state === undefined || state.stopReason === undefined) {
          throw new Error("OpenAI Codex stream ended without a completed state.");
        }
        stream.end({
          type: "done",
          reason: state.stopReason,
          message: structuredClone(message),
          usage: state.usage,
        });
        this.config.logger?.debug("provider.request_ended", {
          provider: "openai-codex",
          stopReason: state.stopReason,
        });
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      const normalized = normalizeOpenAICodexError(error);
      this.config.logger?.error("provider.request_failed", {
        provider: "openai-codex",
        ...formatProviderFailure(normalized, context.signal),
      });
      stream.error({
        type: "error",
        reason: isAbortError(normalized) || context.signal?.aborted ? "aborted" : "error",
        error: normalized,
        snapshot: structuredClone(message),
      });
    }
  }

  private async request(
    body: string,
    retryState: OpenAICodexRetryState,
    signal?: AbortSignal,
  ): Promise<Response> {
    const fetch = this.config.fetch ?? globalThis.fetch;
    const maxRetries = this.config.maxRetries ?? 0;

    for (;;) {
      let response: Response | undefined;
      let failure: unknown;
      try {
        // TODO: Re-evaluate Responses Lite after OpenAI stabilizes its hosted-tool
        // contract. Lite requires a distinct body and transport marker, so the
        // header and request builder must always switch together.
        response = await fetch(resolveOpenAICodexUrl(this.config.baseUrl), {
          method: "POST",
          headers: {
            ...this.config.headers,
            accept: "text/event-stream",
            "content-type": "application/json",
            authorization: `Bearer ${retryState.credentials.accessToken}`,
            "chatgpt-account-id": retryState.credentials.accountId,
            originator: "kana",
            "user-agent": "kana",
          },
          body,
          signal,
        });
        if (response.ok) {
          return response;
        }

        if (response.status === 401 && !retryState.authRefreshed) {
          retryState.authRefreshed = true;
          await response.body?.cancel().catch(() => undefined);
          this.config.logger?.info("provider.authentication_refresh_started", {
            provider: "openai-codex",
            trigger: "http_401",
          });
          const refreshed = await this.config.credentialProvider.refreshCredentials();
          if (refreshed !== undefined) {
            retryState.credentials = refreshed;
            this.config.logger?.info("provider.authentication_refresh_ended", {
              provider: "openai-codex",
              outcome: "refreshed",
            });
            continue;
          }
          this.config.logger?.warn("provider.authentication_refresh_ended", {
            provider: "openai-codex",
            outcome: "unauthorized",
          });
        }

        const responseBody = await response.text().catch(() => "");
        failure = new OpenAICodexHttpError(response.status, response.statusText, responseBody);
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason ?? error;
        }
        if (response?.status === 401 && retryState.authRefreshed) {
          throw error;
        }
        failure = error;
      }

      if (!isOpenAICodexRetryable(failure) || retryState.attempt >= maxRetries) {
        throw failure;
      }

      const delayMs = getOpenAICodexRetryDelayMs(retryState.attempt, response);
      retryState.attempt += 1;
      this.config.logger?.warn("provider.retrying", {
        provider: "openai-codex",
        attempt: retryState.attempt,
        delayMs,
        ...(response === undefined ? {} : { status: response.status }),
      });
      await sleepForOpenAICodexRetry(delayMs, signal);
    }
  }
}

function normalizeOpenAICodexError(error: unknown): unknown {
  if (!(error instanceof OpenAICodexHttpError) || !isContextWindowFailure(error)) {
    return error;
  }
  return new ContextWindowExceededError(
    "OpenAI Codex rejected the request because its context window was exceeded.",
    { cause: error },
  );
}

function isContextWindowFailure(error: OpenAICodexHttpError): boolean {
  if (![400, 413, 422].includes(error.status)) {
    return false;
  }
  return /context.{0,32}(length|window).{0,32}(exceed|too (?:long|large))|(?:input|prompt).{0,32}(?:token|length).{0,32}(?:exceed|too (?:long|large))/i.test(
    error.body,
  );
}

function formatProviderFailure(error: unknown, signal?: AbortSignal): Record<string, unknown> {
  const aborted = isAbortError(error) || signal?.aborted === true;
  if (error instanceof OpenAICodexHttpError) {
    return {
      errorName: error.name,
      aborted,
      status: error.status,
      statusText: error.statusText,
    };
  }
  if (error instanceof ResponsesStreamError) {
    return {
      errorName: error.name,
      aborted,
      errorCode: error.retryable ? "RESPONSES_STREAM_TRANSIENT" : "RESPONSES_STREAM_ERROR",
      eventType: error.eventType,
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      ...(aborted ? {} : { message: error.message }),
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
