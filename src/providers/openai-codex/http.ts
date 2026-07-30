import type { OpenAICodexModelConfig } from "./types";

const MAX_ERROR_BODY_LENGTH = 16_384;

export class OpenAICodexHttpError extends Error {
  readonly body: string;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: string,
  ) {
    const truncatedBody =
      body.length <= MAX_ERROR_BODY_LENGTH ? body : `${body.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
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
  if (!config.timeoutMs) {
    return {
      signal,
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
      controller.abort(
        new Error(`OpenAI Codex request timed out after ${config.timeoutMs}ms of inactivity.`),
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
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return !isAbortError(error);
}

export function getOpenAICodexRetryDelayMs(attempt: number, response?: Response): number {
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

export function sleepForOpenAICodexRetry(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
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

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
