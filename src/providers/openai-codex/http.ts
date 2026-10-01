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
  readonly providerCode?: string;
  readonly param?: string;
  readonly requestId?: string;

  constructor(
    readonly status: number,
    readonly statusText: string,
    body: string,
    requestId?: string,
  ) {
    const truncatedBody = boundProviderHttpErrorBody(body);
    const details = readErrorDetails(body);
    super(
      `OpenAI Codex request failed with ${status} ${statusText}: ${truncatedBody}` +
        recoveryHint(details.code) +
        (requestId ? ` Request ID: ${requestId}.` : ""),
    );
    this.body = truncatedBody;
    this.providerCode = details.code;
    this.param = details.param;
    this.requestId = requestId;
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
  const normalized = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) {
    return normalized;
  }
  return `${normalized}/responses`;
}

export function isOpenAICodexRetryable(error: unknown): boolean {
  if (error instanceof OpenAICodexHttpError) {
    if (error.providerCode === "subscription_sharing_usage_limit_exceeded") return false;
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

function readErrorDetails(body: string): { code?: string; param?: string } {
  try {
    const value = JSON.parse(body);
    return {
      ...(typeof value?.error?.code === "string" ? { code: value.error.code } : {}),
      ...(typeof value?.error?.param === "string" ? { param: value.error.param } : {}),
    };
  } catch {
    return {};
  }
}

export function recoveryHint(code?: string): string {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return " ChatGPT plan usage limit reached. Manage usage: https://chatgpt.com/settings/usage.";
    case "subscription_sharing_user_not_eligible":
      return " ChatGPT plan usage is unavailable for this account or workspace.";
    case "subscription_sharing_unsupported_capability":
      return " This capability is unsupported for ChatGPT plan usage; check error.param.";
    case "subscription_sharing_route_not_supported":
      return " ChatGPT plan usage requires POST /v1/responses.";
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return " Check the saved client registration and granted ChatGPT plan permissions.";
    default:
      return "";
  }
}
