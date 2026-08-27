import {
  boundProviderHttpErrorBody,
  createProviderRequestSignal,
  getExponentialBackoffDelayMs,
  isAbortError,
  isRetryableProviderHttpStatus,
  waitForProviderRetry,
} from "../http";
import { getProviderErrorType, type ProviderRetryDetails } from "../lifecycle";
import type { DeepSeekModelConfig } from "./types";

export class DeepSeekHttpError extends Error {
  readonly body: string;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: string,
  ) {
    const boundedBody = boundProviderHttpErrorBody(body);
    super(`DeepSeek API request failed with ${status} ${statusText}: ${boundedBody}`);
    this.body = boundedBody;
  }
}

export async function fetchWithRetries(
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
      throw new DeepSeekHttpError(response.status, response.statusText, body);
    } catch (error) {
      if (
        init.signal?.aborted ||
        isAbortError(error) ||
        !isRetryableError(error) ||
        attempt >= maxRetries
      ) {
        throw error;
      }

      const delayMs = getExponentialBackoffDelayMs(attempt);
      onRetry?.({
        attempt: attempt + 1,
        delayMs,
        errorCode:
          error instanceof DeepSeekHttpError ? "PROVIDER_HTTP_ERROR" : "PROVIDER_NETWORK_ERROR",
        errorType: getProviderErrorType(error),
        ...(error instanceof DeepSeekHttpError ? { httpStatus: error.status } : {}),
      });
      await waitForProviderRetry(delayMs, init.signal);
    }
  }
}

export function createRequestSignal(
  config: DeepSeekModelConfig,
  signal?: AbortSignal,
): {
  signal?: AbortSignal;
  refresh(): void;
  dispose(): void;
} {
  return createProviderRequestSignal({
    timeoutMs: config.timeoutMs,
    signal,
    timeoutMessage: `DeepSeek request timed out after ${config.timeoutMs}ms.`,
  });
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export { isAbortError };

function shouldRetryStatus(status: number): boolean {
  return isRetryableProviderHttpStatus(status);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DeepSeekHttpError) {
    return shouldRetryStatus(error.status);
  }

  return true;
}
