import type { Logger } from "@/logging";

const PROVIDER_LIFECYCLE_EVENTS = {
  requestStarted: "provider.request_started",
  retrying: "provider.retrying",
  authenticationRefreshStarted: "provider.authentication_refresh_started",
  authenticationRefreshEnded: "provider.authentication_refresh_ended",
  streamRecoveryStarted: "provider.stream_recovery_started",
  streamRecoveryEnded: "provider.stream_recovery_ended",
  requestCompleted: "provider.request_completed",
  requestFailed: "provider.request_failed",
} as const;

export type ProviderRequestPhase =
  | "validation"
  | "authentication"
  | "request_build"
  | "http_request"
  | "response_stream";

export type ProviderErrorCode =
  | "PROVIDER_REQUEST_ABORTED"
  | "PROVIDER_INACTIVITY_TIMEOUT"
  | "PROVIDER_VALIDATION_ERROR"
  | "PROVIDER_AUTHENTICATION_ERROR"
  | "PROVIDER_REQUEST_BUILD_ERROR"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_STREAM_ERROR"
  | "PROVIDER_STREAM_TRANSIENT_ERROR"
  | "PROVIDER_CONTEXT_WINDOW_EXCEEDED";

export type ProviderRetryDetails = {
  attempt: number;
  delayMs: number;
  errorCode: "PROVIDER_HTTP_ERROR" | "PROVIDER_NETWORK_ERROR";
  errorType: string;
  httpStatus?: number;
};

export type ProviderFailureMetadata = {
  phase: ProviderRequestPhase;
  outcome: "failed" | "aborted" | "timed_out";
  errorCode: ProviderErrorCode;
  errorType: string;
  httpStatus?: number;
  eventType?: string;
  providerCode?: string;
};

type ProviderIdentity = {
  provider: string;
  model: string;
  protocol: "chat-completions" | "responses";
};

export type ProviderDiagnostics = {
  requestStarted(): void;
  retrying(details: ProviderRetryDetails): void;
  authenticationRefreshStarted(trigger: "http_401"): void;
  authenticationRefreshEnded(
    details:
      | { outcome: "refreshed" | "unauthorized" }
      | {
          outcome: "failed";
          errorCode: "PROVIDER_AUTHENTICATION_ERROR";
          errorType: string;
        },
  ): void;
  streamRecoveryStarted(details: {
    attempt: number;
    delayMs: number;
    errorCode: "PROVIDER_STREAM_TRANSIENT_ERROR";
    errorType: string;
    eventType: string;
    providerCode?: string;
  }): void;
  streamRecoveryEnded(attempt: number): void;
  requestCompleted(stopReason: string): void;
  requestFailed(details: ProviderFailureMetadata): void;
};

export function createProviderDiagnostics(
  logger: Logger | undefined,
  identity: ProviderIdentity,
): ProviderDiagnostics {
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    event: (typeof PROVIDER_LIFECYCLE_EVENTS)[keyof typeof PROVIDER_LIFECYCLE_EVENTS],
    metadata: Record<string, unknown>,
  ): void => {
    try {
      logger?.[level](event, { ...identity, ...metadata });
    } catch {
      // Provider diagnostics must never change request control flow.
    }
  };

  return {
    requestStarted() {
      emit("debug", PROVIDER_LIFECYCLE_EVENTS.requestStarted, {
        phase: "validation",
        outcome: "started",
      });
    },
    retrying(details) {
      emit("warn", PROVIDER_LIFECYCLE_EVENTS.retrying, {
        phase: "http_request",
        outcome: "retrying",
        ...details,
      });
    },
    authenticationRefreshStarted(trigger) {
      emit("info", PROVIDER_LIFECYCLE_EVENTS.authenticationRefreshStarted, {
        phase: "authentication",
        outcome: "started",
        trigger,
        httpStatus: 401,
      });
    },
    authenticationRefreshEnded(details) {
      emit(
        details.outcome === "refreshed" ? "info" : "warn",
        PROVIDER_LIFECYCLE_EVENTS.authenticationRefreshEnded,
        {
          phase: "authentication",
          ...details,
        },
      );
    },
    streamRecoveryStarted(details) {
      emit("warn", PROVIDER_LIFECYCLE_EVENTS.streamRecoveryStarted, {
        phase: "response_stream",
        outcome: "retrying",
        ...details,
      });
    },
    streamRecoveryEnded(attempt) {
      emit("info", PROVIDER_LIFECYCLE_EVENTS.streamRecoveryEnded, {
        phase: "response_stream",
        outcome: "recovered",
        attempt,
      });
    },
    requestCompleted(stopReason) {
      emit("debug", PROVIDER_LIFECYCLE_EVENTS.requestCompleted, {
        phase: "response_stream",
        outcome: "completed",
        stopReason,
      });
    },
    requestFailed(details) {
      emit("error", PROVIDER_LIFECYCLE_EVENTS.requestFailed, details);
    },
  };
}

export function formatProviderFailure(
  error: unknown,
  options: {
    phase: ProviderRequestPhase;
    signal?: AbortSignal;
    timedOut?: boolean;
    errorCode?: ProviderErrorCode;
    errorType?: string;
    httpStatus?: number;
    eventType?: string;
    providerCode?: string;
  },
): ProviderFailureMetadata {
  const timedOut = options.timedOut === true;
  const aborted = !timedOut && (isAbortError(error) || options.signal?.aborted === true);
  const outcome = timedOut ? "timed_out" : aborted ? "aborted" : "failed";
  const errorCode = timedOut
    ? "PROVIDER_INACTIVITY_TIMEOUT"
    : aborted
      ? "PROVIDER_REQUEST_ABORTED"
      : (options.errorCode ?? defaultErrorCode(options.phase));

  return {
    phase: options.phase,
    outcome,
    errorCode,
    errorType: options.errorType ?? getProviderErrorType(error),
    ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
    ...(options.eventType === undefined ? {} : { eventType: options.eventType }),
    ...(options.providerCode === undefined ? {} : { providerCode: options.providerCode }),
  };
}

export function getProviderErrorType(error: unknown): string {
  if (error instanceof DOMException) {
    return error.name;
  }
  if (error instanceof Error) {
    const constructorName = error.constructor.name;
    return constructorName === "Error" ? error.name : constructorName;
  }
  return typeof error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function defaultErrorCode(phase: ProviderRequestPhase): ProviderErrorCode {
  switch (phase) {
    case "validation":
      return "PROVIDER_VALIDATION_ERROR";
    case "authentication":
      return "PROVIDER_AUTHENTICATION_ERROR";
    case "request_build":
      return "PROVIDER_REQUEST_BUILD_ERROR";
    case "http_request":
      return "PROVIDER_NETWORK_ERROR";
    case "response_stream":
      return "PROVIDER_STREAM_ERROR";
  }
}
