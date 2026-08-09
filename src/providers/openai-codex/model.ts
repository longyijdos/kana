import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  ContextWindowExceededError,
  type ModelContext,
} from "@/core";
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
      role: "assistant",
      content: [],
    };
    const state: OpenAICodexStreamState = {
      terminalSeen: false,
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

      const requestSignal = createOpenAICodexRequestSignal(this.config, context.signal);
      try {
        const response = await this.request(
          JSON.stringify(
            buildOpenAICodexRequest(
              {
                ...context,
                parallelToolCalls:
                  context.parallelToolCalls === true && this.metadata.supportsParallelToolCalls,
              },
              this.config,
            ),
          ),
          credentials,
          requestSignal.signal,
        );
        requestSignal.refresh();
        stream.push({
          type: "start",
          snapshot: structuredClone(message),
        });

        const processor = new OpenAICodexStreamProcessor(stream, message, state);
        await readOpenAICodexStream(
          response,
          (event) => processor.apply(event),
          requestSignal.refresh,
        );
        if (!state.terminalSeen || state.stopReason === undefined) {
          throw new Error("OpenAI Codex stream ended before a terminal response event.");
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
    initialCredentials: OpenAICodexCredentials,
    signal?: AbortSignal,
  ): Promise<Response> {
    const fetch = this.config.fetch ?? globalThis.fetch;
    const maxRetries = this.config.maxRetries ?? 0;
    let credentials = initialCredentials;
    let authRefreshed = false;
    let retryAttempt = 0;

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
            authorization: `Bearer ${credentials.accessToken}`,
            "chatgpt-account-id": credentials.accountId,
            originator: "kana",
            "user-agent": "kana",
          },
          body,
          signal,
        });
        if (response.ok) {
          return response;
        }

        if (response.status === 401 && !authRefreshed) {
          authRefreshed = true;
          await response.body?.cancel().catch(() => undefined);
          this.config.logger?.info("provider.authentication_refresh_started", {
            provider: "openai-codex",
            trigger: "http_401",
          });
          const refreshed = await this.config.credentialProvider.refreshCredentials();
          if (refreshed !== undefined) {
            credentials = refreshed;
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
        if (response?.status === 401 && authRefreshed) {
          throw error;
        }
        failure = error;
      }

      if (!isOpenAICodexRetryable(failure) || retryAttempt >= maxRetries) {
        throw failure;
      }

      const delayMs = getOpenAICodexRetryDelayMs(retryAttempt, response);
      retryAttempt += 1;
      this.config.logger?.warn("provider.retrying", {
        provider: "openai-codex",
        attempt: retryAttempt,
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
  if (error instanceof Error) {
    return {
      errorName: error.name,
      aborted,
      ...(aborted ? {} : { message: error.message }),
    };
  }
  return { errorName: typeof error, aborted };
}
