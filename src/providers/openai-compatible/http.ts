import type { OpenAICompatibleModelConfig } from "./types";

const MAX_ERROR_BODY_LENGTH = 16_384;

export class OpenAICompatibleHttpError extends Error {
  readonly body: string;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: string,
  ) {
    const truncatedBody =
      body.length <= MAX_ERROR_BODY_LENGTH ? body : `${body.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
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
  if (!config.timeoutMs) {
    return { signal, refresh() {}, dispose() {} };
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const refresh = (): void => {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      return;
    }
    timeout = setTimeout(() => {
      controller.abort(
        new Error(
          `OpenAI-compatible provider ${config.provider}/${config.model} timed out after ${config.timeoutMs}ms of inactivity.`,
        ),
      );
    }, config.timeoutMs);
  };
  const abort = (): void => controller.abort(signal?.reason);

  refresh();
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    refresh,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export async function fetchOpenAICompatibleWithRetries(
  url: string,
  init: RequestInit,
  maxRetries: number,
  onRetry?: (details: { attempt: number; delayMs: number; status?: number }) => void,
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
      onRetry?.({ attempt: attempt + 1, delayMs, status: response.status });
      await sleep(delayMs, init.signal);
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
      onRetry?.({ attempt: attempt + 1, delayMs });
      await sleep(delayMs, init.signal);
    }
  }
}

export function resolveOpenAICompatibleUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function getRetryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, 30_000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(0, date - Date.now()), 30_000);
    }
  }
  return Math.min(1_000 * 2 ** attempt, 8_000);
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
