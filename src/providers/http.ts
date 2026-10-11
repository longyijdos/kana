import { isRecord } from "@/utils";
import { getProviderErrorType, isAbortError, type ProviderRetryDetails } from "./lifecycle";

export const MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH = 16_384;

export class ProviderHttpError extends Error {
  readonly body: string;
  readonly providerCode?: string;
  readonly providerParam?: string;

  constructor(
    label: string,
    readonly status: number,
    readonly statusText: string,
    body: string,
    readonly requestId?: string,
    describeCode?: (code: string | undefined) => string,
  ) {
    const boundedBody = boundProviderHttpErrorBody(body);
    const details = readErrorDetails(body);
    super(
      `${label} request failed with ${status} ${statusText}: ${boundedBody}` +
        (describeCode?.(details.code) ?? "") +
        (requestId ? ` Request ID: ${requestId}.` : ""),
    );
    this.body = boundedBody;
    this.providerCode = details.code;
    this.providerParam = details.param;
  }
}

export type FetchWithRetriesOptions = {
  // Prefix of HTTP error messages, such as "DeepSeek API".
  label: string;
  maxRetries: number;
  fetch?: typeof globalThis.fetch;
  onRetry?: (details: ProviderRetryDetails) => void;
  isRetryable?: (error: ProviderHttpError) => boolean;
  describeCode?: (code: string | undefined) => string;
  // Runs once on the first 401. Returning a request retries it immediately
  // without spending a retry attempt.
  refreshOn401?: () => Promise<RequestInit | undefined>;
};

export async function fetchWithRetries(
  url: string,
  init: RequestInit,
  options: FetchWithRetriesOptions,
): Promise<Response> {
  const fetchResponse = options.fetch ?? globalThis.fetch;
  const isRetryable =
    options.isRetryable ?? ((error) => isRetryableProviderHttpStatus(error.status));
  let request = init;
  let refreshed = false;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await fetchResponse(url, request);
      if (response.ok) {
        return response;
      }
    } catch (error) {
      if (request.signal?.aborted) {
        throw request.signal.reason ?? error;
      }
      failure = error;
    }

    if (response) {
      const body = await response.text().catch(() => "");
      if (response.status === 401 && options.refreshOn401 && !refreshed) {
        refreshed = true;
        const next = await options.refreshOn401();
        if (next) {
          request = next;
          attempt -= 1;
          continue;
        }
      }
      failure = new ProviderHttpError(
        options.label,
        response.status,
        response.statusText,
        body,
        response.headers.get("x-request-id") ??
          response.headers.get("openai-request-id") ??
          undefined,
        options.describeCode,
      );
    }

    const retryable =
      failure instanceof ProviderHttpError ? isRetryable(failure) : !isAbortError(failure);
    if (!retryable || attempt >= options.maxRetries) {
      throw failure;
    }

    const delayMs =
      (failure instanceof ProviderHttpError ? getRetryAfterDelayMs(response) : undefined) ??
      getExponentialBackoffDelayMs(attempt);
    options.onRetry?.({
      attempt: attempt + 1,
      delayMs,
      errorCode:
        failure instanceof ProviderHttpError ? "PROVIDER_HTTP_ERROR" : "PROVIDER_NETWORK_ERROR",
      errorType: getProviderErrorType(failure),
      ...(failure instanceof ProviderHttpError ? { httpStatus: failure.status } : {}),
    });
    await waitForProviderRetry(delayMs, request.signal);
  }
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export type ProviderRequestSignal = {
  signal?: AbortSignal;
  refresh(): void;
  dispose(): void;
};

class ProviderInactivityTimeoutError extends Error {}

// Aborts when the caller aborts or when no activity refreshes the timer for
// `timeoutMs`. Callers refresh it on every response byte.
export function createProviderRequestSignal(options: {
  timeoutMs?: number;
  signal?: AbortSignal;
  timeoutMessage: string;
}): ProviderRequestSignal {
  if (!options.timeoutMs) {
    return { signal: options.signal, refresh() {}, dispose() {} };
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

function readErrorDetails(body: string): { code?: string; param?: string } {
  try {
    const value: unknown = JSON.parse(body);
    const error = isRecord(value) && isRecord(value.error) ? value.error : {};
    return {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.param === "string" ? { param: error.param } : {}),
    };
  } catch {
    return {};
  }
}
