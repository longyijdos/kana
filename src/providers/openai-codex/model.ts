import { BaseModel, type ModelContext } from "@/core";
import { isContextWindowFailure } from "../context-window";
import {
  createProviderRequestSignal,
  fetchWithRetries,
  getExponentialBackoffDelayMs,
  getRetryAfterDelayMs,
  MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH,
  type ProviderHttpError,
  waitForProviderRetry,
} from "../http";
import {
  createProviderDiagnostics,
  getProviderErrorType,
  type ProviderDiagnostics,
} from "../lifecycle";
import {
  isRetryableResponsesStreamError,
  ResponsesStreamError,
  ResponsesStreamProcessor,
  type ResponsesStreamState,
} from "../responses";
import { assertOutputLimit, streamProviderRequest, toContextWindowError } from "../run";
import { readSseJson } from "../sse";
import { isOpenAICodexRetryable, recoveryHint, resolveOpenAICodexUrl } from "./http";
import { getOpenAICodexModelMetadata } from "./metadata";
import { buildOpenAICodexRequest } from "./request";
import type { OpenAICodexModelConfig } from "./types";

const CONTEXT_WINDOW_MESSAGE =
  /context.{0,32}(length|window).{0,32}(exceed|too (?:long|large))|(?:input|prompt).{0,32}(?:token|length).{0,32}(?:exceed|too (?:long|large))/i;

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

  stream(context: ModelContext) {
    const { config, diagnostics } = this;
    return streamProviderRequest(
      context,
      { diagnostics, normalizeError: normalizeOpenAICodexError },
      async ({ stream, message, setPhase }) => {
        assertOutputLimit(
          `OpenAI Codex model "${config.model}"`,
          this.metadata.maxOutputTokens,
          config.maxOutputTokens,
          context.maxOutputTokens,
        );

        setPhase("authentication");
        let credentials = await config.credentialProvider.getCredentials();
        if (credentials === undefined) {
          throw new Error(
            "OpenAI Codex is not authorized. Run `kana auth login openai-codex` first.",
          );
        }

        setPhase("request_build");
        const body = JSON.stringify(buildOpenAICodexRequest(context, config));
        const requestSignal = createProviderRequestSignal({
          timeoutMs: config.timeoutMs,
          signal: context.signal,
          timeoutMessage: `OpenAI Codex request timed out after ${config.timeoutMs}ms of inactivity.`,
        });
        const createRequest = (accessToken: string): RequestInit => ({
          method: "POST",
          headers: {
            ...config.headers,
            accept: "text/event-stream",
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
            originator: "kana",
            "user-agent": "kana",
            ...(config.sessionId === undefined
              ? {}
              : { session_id: config.sessionId, "x-client-request-id": config.sessionId }),
          },
          body,
          signal: requestSignal.signal,
        });
        const maxRetries = config.maxRetries ?? 0;

        try {
          // A transient stream failure before any output is visible replays the
          // whole request; once output has started the failure is final. HTTP
          // retries and stream recoveries share one retry budget.
          let retriesUsed = 0;
          for (let recoveries = 0; ; ) {
            setPhase("http_request");
            const response = await fetchWithRetries(
              resolveOpenAICodexUrl(config.baseUrl),
              createRequest(credentials.accessToken),
              {
                label: "OpenAI Codex",
                maxRetries: maxRetries - retriesUsed,
                fetch: config.fetch,
                onRetry: (details) => {
                  retriesUsed += 1;
                  diagnostics.retrying({ ...details, attempt: retriesUsed });
                },
                isRetryable: isOpenAICodexRetryable,
                describeCode: recoveryHint,
                refreshOn401: async () => {
                  setPhase("authentication");
                  diagnostics.authenticationRefreshStarted("http_401");
                  const refreshed = await this.refreshCredentials();
                  setPhase("http_request");
                  if (refreshed === undefined) return undefined;
                  credentials = refreshed;
                  return createRequest(refreshed.accessToken);
                },
              },
            );
            requestSignal.refresh();
            if (recoveries > 0) {
              diagnostics.streamRecoveryEnded(retriesUsed);
            }
            if (recoveries === 0) {
              stream.push({ type: "start", snapshot: message.snapshot() });
            }

            setPhase("response_stream");
            const state: ResponsesStreamState = {};
            const processor = new ResponsesStreamProcessor(stream, message, state, {
              provider: "openai-codex",
              providerLabel: "OpenAI Codex",
              ignoredEventTypes: ["response.done"],
            });
            try {
              await readSseJson(
                response,
                "OpenAI Codex",
                (event) => processor.apply(event),
                requestSignal.refresh,
              );
              if (state.stopReason === undefined) {
                throw new Error("OpenAI Codex stream ended before a terminal response event.");
              }
              return { stopReason: state.stopReason, usage: state.usage };
            } catch (error) {
              if (error instanceof ResponsesStreamError) {
                error.requestId =
                  response.headers.get("x-request-id") ??
                  response.headers.get("openai-request-id") ??
                  undefined;
              }
              if (
                !isRetryableResponsesStreamError(error) ||
                processor.hasStartedOutput ||
                retriesUsed >= maxRetries
              ) {
                throw error;
              }
              const delayMs =
                getRetryAfterDelayMs(response) ?? getExponentialBackoffDelayMs(retriesUsed);
              recoveries += 1;
              retriesUsed += 1;
              diagnostics.streamRecoveryStarted({
                attempt: retriesUsed,
                delayMs,
                errorCode: "PROVIDER_STREAM_TRANSIENT_ERROR",
                errorType: getProviderErrorType(error),
                eventType: error.eventType,
                ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
              });
              await waitForProviderRetry(delayMs, requestSignal.signal);
            }
          }
        } finally {
          requestSignal.dispose();
        }
      },
    );
  }

  private async refreshCredentials() {
    try {
      const refreshed = await this.config.credentialProvider.refreshCredentials();
      this.diagnostics.authenticationRefreshEnded({
        outcome: refreshed === undefined ? "unauthorized" : "refreshed",
      });
      return refreshed;
    } catch (error) {
      this.diagnostics.authenticationRefreshEnded({
        outcome: "failed",
        errorCode: "PROVIDER_AUTHENTICATION_ERROR",
        errorType: getProviderErrorType(error),
      });
      throw error;
    }
  }
}

function normalizeOpenAICodexError(error: unknown): unknown {
  if (error instanceof ResponsesStreamError) {
    error.message +=
      recoveryHint(error.providerCode) +
      (error.providerParam ? ` Parameter: ${error.providerParam}.` : "") +
      (error.requestId ? ` Request ID: ${error.requestId}.` : "");
    return error;
  }
  return toContextWindowError(error, "OpenAI Codex", (httpError: ProviderHttpError) =>
    isContextWindowFailure({
      status: httpError.status,
      message: httpError.body,
      messageLimit: MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH,
      includeCommonMessageSignals: false,
      providerSignal: CONTEXT_WINDOW_MESSAGE.test(httpError.body),
    }),
  );
}
