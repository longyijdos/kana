import {
  AssistantEventStream,
  AssistantMessageBuilder,
  type AssistantStopReason,
  ContextWindowExceededError,
  type ModelContext,
  type ModelUsage,
} from "@/core";
import { isProviderInactivityTimeout, ProviderHttpError } from "./http";
import {
  formatProviderFailure,
  isAbortError,
  type ProviderDiagnostics,
  type ProviderErrorCode,
  type ProviderRequestPhase,
} from "./lifecycle";
import { ResponsesStreamError } from "./responses/stream";

export type ProviderRunContext = {
  stream: AssistantEventStream;
  message: AssistantMessageBuilder;
  // Records the phase that a failure will be attributed to.
  setPhase(phase: ProviderRequestPhase): void;
};

export type ProviderRunResult = {
  stopReason: Extract<AssistantStopReason, "stop" | "length" | "toolUse">;
  usage?: ModelUsage;
};

// The shared request lifecycle: each adapter supplies only the part that sends
// its request and parses the response into `message`.
export function streamProviderRequest(
  context: ModelContext,
  options: {
    diagnostics: ProviderDiagnostics;
    normalizeError?: (error: unknown) => unknown;
  },
  run: (run: ProviderRunContext) => Promise<ProviderRunResult>,
): AssistantEventStream {
  const stream = new AssistantEventStream();
  const message = new AssistantMessageBuilder();
  const { diagnostics } = options;
  let phase: ProviderRequestPhase = "validation";

  void (async () => {
    try {
      diagnostics.requestStarted();
      const { stopReason, usage } = await run({
        stream,
        message,
        setPhase: (next) => {
          phase = next;
        },
      });
      stream.end({ type: "done", reason: stopReason, message: message.snapshot(), usage });
      diagnostics.requestCompleted(stopReason);
    } catch (error) {
      const normalized = options.normalizeError?.(error) ?? error;
      diagnostics.requestFailed(
        formatProviderFailure(normalized, {
          phase,
          signal: context.signal,
          timedOut: isProviderInactivityTimeout(error),
          errorCode: classifyProviderError(error, normalized),
          ...(error instanceof ProviderHttpError ? { httpStatus: error.status } : {}),
          ...(error instanceof ResponsesStreamError
            ? {
                eventType: error.eventType,
                ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
              }
            : {}),
        }),
      );
      stream.error({
        type: "error",
        reason: isAbortError(normalized) || context.signal?.aborted ? "aborted" : "error",
        error: normalized,
        snapshot: message.snapshot(),
      });
    }
  })();

  return stream;
}

export function toContextWindowError(
  error: unknown,
  providerLabel: string,
  isContextWindowFailure: (error: ProviderHttpError) => boolean,
): unknown {
  return error instanceof ProviderHttpError && isContextWindowFailure(error)
    ? new ContextWindowExceededError(
        `${providerLabel} rejected the request because its context window was exceeded.`,
        { cause: error },
      )
    : error;
}

export function assertOutputLimit(
  modelLabel: string,
  supported: number,
  ...requested: Array<number | undefined>
): void {
  if (requested.some((tokens) => tokens !== undefined && tokens > supported)) {
    throw new Error(`${modelLabel} supports at most ${supported} output tokens.`);
  }
}

function classifyProviderError(error: unknown, normalized: unknown): ProviderErrorCode | undefined {
  if (normalized instanceof ContextWindowExceededError) {
    return "PROVIDER_CONTEXT_WINDOW_EXCEEDED";
  }
  if (error instanceof ProviderHttpError) {
    return "PROVIDER_HTTP_ERROR";
  }
  if (error instanceof ResponsesStreamError) {
    return error.retryable ? "PROVIDER_STREAM_TRANSIENT_ERROR" : "PROVIDER_STREAM_ERROR";
  }
  return undefined;
}
