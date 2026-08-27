export { isAbortError } from "./lifecycle";

export const MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH = 16_384;

export type ProviderRequestSignal = {
  signal?: AbortSignal;
  refresh(): void;
  dispose(): void;
};

class ProviderInactivityTimeoutError extends Error {}

export function createProviderRequestSignal(options: {
  timeoutMs?: number;
  signal?: AbortSignal;
  timeoutMessage: string;
}): ProviderRequestSignal {
  if (!options.timeoutMs) {
    return {
      signal: options.signal,
      refresh() {},
      dispose() {},
    };
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const refresh = (): void => {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      return;
    }
    timeout = setTimeout(() => {
      controller.abort(new ProviderInactivityTimeoutError(options.timeoutMessage));
    }, options.timeoutMs);
  };
  const abort = (): void => controller.abort(options.signal?.reason);

  refresh();
  if (options.signal?.aborted) {
    abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    refresh,
    dispose() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}

export function isProviderInactivityTimeout(error: unknown): boolean {
  return error instanceof ProviderInactivityTimeoutError;
}

export function boundProviderHttpErrorBody(body: string): string {
  return body.length <= MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH
    ? body
    : `${body.slice(0, MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH)}…`;
}

export function isRetryableProviderHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function getExponentialBackoffDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 8_000);
}

export function getRetryAfterDelayMs(response?: Response): number | undefined {
  const retryAfter = response?.headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 30_000);
  }

  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.min(Math.max(0, date - Date.now()), 30_000);
}

export function waitForProviderRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
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
    }, delayMs);
    const abort = (): void => {
      cleanup();
      reject(signal?.reason);
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}
