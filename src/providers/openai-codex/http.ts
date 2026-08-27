import {
  boundProviderHttpErrorBody,
  createProviderRequestSignal,
  getExponentialBackoffDelayMs,
  getRetryAfterDelayMs,
  isAbortError,
  isRetryableProviderHttpStatus,
  waitForProviderRetry,
} from "../http";
import type { OpenAICodexModelConfig } from "./types";

export class OpenAICodexHttpError extends Error {
  readonly body: string;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: string,
  ) {
    const truncatedBody = boundProviderHttpErrorBody(body);
    super(`OpenAI Codex request failed with ${status} ${statusText}: ${truncatedBody}`);
    this.body = truncatedBody;
  }
}

export function createOpenAICodexRequestSignal(
  config: OpenAICodexModelConfig,
  signal?: AbortSignal,
): {
  signal?: AbortSignal;
  refresh(): void;
  dispose(): void;
} {
  return createProviderRequestSignal({
    timeoutMs: config.timeoutMs,
    signal,
    timeoutMessage: `OpenAI Codex request timed out after ${config.timeoutMs}ms of inactivity.`,
  });
}

export function resolveOpenAICodexUrl(baseUrl?: string): string {
  const normalized = (baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

export function isOpenAICodexRetryable(error: unknown): boolean {
  if (error instanceof OpenAICodexHttpError) {
    return isRetryableProviderHttpStatus(error.status);
  }
  return !isAbortError(error);
}

export function getOpenAICodexRetryDelayMs(attempt: number, response?: Response): number {
  return getRetryAfterDelayMs(response) ?? getExponentialBackoffDelayMs(attempt);
}

export function sleepForOpenAICodexRetry(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return waitForProviderRetry(delayMs, signal);
}

export { isAbortError };
