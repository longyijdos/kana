import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  ContextWindowExceededError,
  createMessageIdentity,
  type ModelContext,
} from "@/core";
import { isContextWindowFailure } from "../context-window";
import { isProviderInactivityTimeout, MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH } from "../http";
import {
  createProviderDiagnostics,
  formatProviderFailure,
  getProviderErrorType,
  type ProviderDiagnostics,
  type ProviderErrorCode,
  type ProviderRequestPhase,
} from "../lifecycle";
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
  private readonly diagnostics: ProviderDiagnostics;

  constructor(private readonly config: OpenAICodexModelConfig) {
    super();
    this.metadata = getOpenAICodexModelMetadata(config.model);
    this.diagnostics = createProviderDiagnostics(config.logger, {
      provider: "openai-codex",
      model: config.model,
      protocol: "responses",
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
      if (
        this.config.maxOutputTokens !== undefined &&
        this.config.maxOutputTokens > this.metadata.maxOutputTokens
      ) {
        throw new Error(
          `OpenAI Codex model "${this.config.model}" supports at most ${this.metadata.maxOutputTokens} output tokens.`,
        );
      }

      phase = "authentication";
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
      phase = "request_build";
      const body = JSON.stringify(
        buildOpenAICodexRequest(
          {
            ...context,
            parallelToolCalls:
              context.parallelToolCalls === true && this.metadata.supportsParallelToolCalls,
            webSearch: context.webSearch === true && this.metadata.supportsHostedWebSearch,
            imageInput: context.imageInput === true && this.metadata.supportsImageInput === true,
          },
          this.config,
        ),
      );
      phase = "http_request";
      const requestSignal = createOpenAICodexRequestSignal(this.config, context.signal);
      try {
        let started = false;
        let completedState: OpenAICodexStreamState | undefined;
        let recovering = false;

        for (;;) {
          const response = await this.request(
            body,
            retryState,
            requestSignal.signal,
            (nextPhase) => {
              phase = nextPhase;
            },
          );
          requestSignal.refresh();
          if (recovering) {
            this.diagnostics.streamRecoveryEnded(retryState.attempt);
            recovering = false;
          }
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
          phase = "response_stream";
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
            recovering = true;
            this.diagnostics.streamRecoveryStarted({
              attempt: retryState.attempt,
              delayMs,
              errorCode: "PROVIDER_STREAM_TRANSIENT_ERROR",
              errorType: getProviderErrorType(error),
              eventType: error.eventType,
              ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
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
        this.diagnostics.requestCompleted(state.stopReason);
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      const normalized = normalizeOpenAICodexError(error);
      this.diagnostics.requestFailed(
        formatProviderFailure(normalized, {
          phase,
          signal: context.signal,
          timedOut: isProviderInactivityTimeout(error),
          errorCode: getOpenAICodexErrorCode(error, normalized),
          ...(error instanceof OpenAICodexHttpError ? { httpStatus: error.status } : {}),
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

  private async request(
    body: string,
    retryState: OpenAICodexRetryState,
    signal?: AbortSignal,
    onPhaseChange?: (phase: "http_request" | "authentication") => void,
  ): Promise<Response> {
    const fetch = this.config.fetch ?? globalThis.fetch;
    const maxRetries = this.config.maxRetries ?? 0;

    for (;;) {
      onPhaseChange?.("http_request");
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
          onPhaseChange?.("authentication");
          this.diagnostics.authenticationRefreshStarted("http_401");
          let refreshed: OpenAICodexCredentials | undefined;
          try {
            refreshed = await this.config.credentialProvider.refreshCredentials();
          } catch (error) {
            this.diagnostics.authenticationRefreshEnded({
              outcome: "failed",
              errorCode: "PROVIDER_AUTHENTICATION_ERROR",
              errorType: getProviderErrorType(error),
            });
            throw error;
          }
          if (refreshed !== undefined) {
            retryState.credentials = refreshed;
            this.diagnostics.authenticationRefreshEnded({ outcome: "refreshed" });
            continue;
          }
          this.diagnostics.authenticationRefreshEnded({ outcome: "unauthorized" });
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
      this.diagnostics.retrying({
        attempt: retryState.attempt,
        delayMs,
        errorCode:
          failure instanceof OpenAICodexHttpError
            ? "PROVIDER_HTTP_ERROR"
            : "PROVIDER_NETWORK_ERROR",
        errorType: getProviderErrorType(failure),
        ...(response === undefined ? {} : { httpStatus: response.status }),
      });
      await sleepForOpenAICodexRetry(delayMs, signal);
    }
  }
}

function normalizeOpenAICodexError(error: unknown): unknown {
  if (!(error instanceof OpenAICodexHttpError) || !isOpenAICodexContextWindowFailure(error)) {
    return error;
  }
  return new ContextWindowExceededError(
    "OpenAI Codex rejected the request because its context window was exceeded.",
    { cause: error },
  );
}

function isOpenAICodexContextWindowFailure(error: OpenAICodexHttpError): boolean {
  return isContextWindowFailure({
    status: error.status,
    message: error.body,
    messageLimit: MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH,
    includeCommonMessageSignals: false,
    providerSignal:
      /context.{0,32}(length|window).{0,32}(exceed|too (?:long|large))|(?:input|prompt).{0,32}(?:token|length).{0,32}(?:exceed|too (?:long|large))/i.test(
        error.body,
      ),
  });
}

function getOpenAICodexErrorCode(
  error: unknown,
  normalized: unknown,
): ProviderErrorCode | undefined {
  if (normalized instanceof ContextWindowExceededError) {
    return "PROVIDER_CONTEXT_WINDOW_EXCEEDED";
  }
  if (error instanceof OpenAICodexHttpError) {
    return "PROVIDER_HTTP_ERROR";
  }
  if (error instanceof ResponsesStreamError) {
    return error.retryable ? "PROVIDER_STREAM_TRANSIENT_ERROR" : "PROVIDER_STREAM_ERROR";
  }
  return undefined;
}
