import type { DeepSeekModelConfig } from "./types";

export class DeepSeekHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`DeepSeek API request failed with ${status} ${statusText}: ${body}`);
  }
}

export async function fetchWithRetries(
  url: string,
  init: RequestInit,
  maxRetries: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);

      if (response.ok) {
        return response;
      }

      const body = await response.text().catch(() => "");
      throw new DeepSeekHttpError(
        response.status,
        response.statusText,
        body,
      );
    } catch (error) {
      if (
        isAbortError(error) ||
        !isRetryableError(error) ||
        attempt >= maxRetries
      ) {
        throw error;
      }
    }

    await sleep(retryDelayMs(attempt), init.signal);
  }
}

export function createRequestSignal(config: DeepSeekModelConfig): {
  signal?: AbortSignal;
  dispose(): void;
} {
  if (!config.timeoutMs) {
    return {
      signal: config.signal,
      dispose() {},
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`DeepSeek request timed out after ${config.timeoutMs}ms.`));
  }, config.timeoutMs);
  const abort = (): void => {
    controller.abort(config.signal?.reason);
  };

  if (config.signal?.aborted) {
    abort();
  } else {
    config.signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      config.signal?.removeEventListener("abort", abort);
    },
  };
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  );
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DeepSeekHttpError) {
    return shouldRetryStatus(error.status);
  }

  return true;
}

function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      cleanup();
      reject(signal?.reason);
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}
