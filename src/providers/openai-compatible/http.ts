import {
  boundProviderHttpErrorBody,
  createProviderRequestSignal,
  getExponentialBackoffDelayMs,
  getRetryAfterDelayMs,
  isAbortError,
  isRetryableProviderHttpStatus,
  waitForProviderRetry,
} from "../http";
import { getProviderErrorType, type ProviderRetryDetails } from "../lifecycle";
import type { OpenAICompatibleModelConfig } from "./types";

export class OpenAICompatibleHttpError extends Error {
  readonly body: string;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: string,
  ) {
    const truncatedBody = boundProviderHttpErrorBody(body);
    super(
      `OpenAI-compatible provider request failed with ${status} ${statusText}: ${truncatedBody}`,
    );
    this.body = truncatedBody;
  }
}

export function createOpenAICompatibleRequestSignal(
  config: OpenAICompatibleModelConfig,
  signal?: AbortSignal,
): {
  signal?: AbortSignal;
  refresh(): void;
  dispose(): void;
} {
  return createProviderRequestSignal({
    timeoutMs: config.timeoutMs,
    signal,
    timeoutMessage: `OpenAI-compatible provider ${config.provider}/${config.model} timed out after ${config.timeoutMs}ms of inactivity.`,
  });
}

export async function fetchOpenAICompatibleWithRetries(
  url: string,
  init: RequestInit,
  maxRetries: number,
  onRetry?: (details: ProviderRetryDetails) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return response;
      }

      const body = await response.text().catch(() => "");
      const error = new OpenAICompatibleHttpError(response.status, response.statusText, body);
      if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = getRetryDelayMs(attempt, response);
      onRetry?.({
        attempt: attempt + 1,
        delayMs,
        errorCode: "PROVIDER_HTTP_ERROR",
        errorType: getProviderErrorType(error),
        httpStatus: response.status,
      });
      await waitForProviderRetry(delayMs, init.signal);
    } catch (error) {
      if (
        error instanceof OpenAICompatibleHttpError ||
        isAbortError(error) ||
        init.signal?.aborted ||
        attempt >= maxRetries
      ) {
        throw error;
      }
      const delayMs = getRetryDelayMs(attempt);
      onRetry?.({
        attempt: attempt + 1,
        delayMs,
        errorCode: "PROVIDER_NETWORK_ERROR",
        errorType: getProviderErrorType(error),
      });
      await waitForProviderRetry(delayMs, init.signal);
    }
  }
}

export function resolveOpenAICompatibleUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export { isAbortError };

function isRetryableStatus(status: number): boolean {
  return isRetryableProviderHttpStatus(status);
}

function getRetryDelayMs(attempt: number, response?: Response): number {
  return getRetryAfterDelayMs(response) ?? getExponentialBackoffDelayMs(attempt);
}
