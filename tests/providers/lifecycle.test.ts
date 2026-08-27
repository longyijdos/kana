import { describe, expect, test } from "bun:test";
import type { Logger } from "@/logging";
import { createProviderDiagnostics, formatProviderFailure } from "../../src/providers/lifecycle";
import { createRecordingLogger, type RecordedLog } from "../helpers/logging";

describe("provider lifecycle diagnostics", () => {
  test("uses one event and metadata vocabulary across lifecycle boundaries", () => {
    const records: RecordedLog[] = [];
    const diagnostics = createProviderDiagnostics(createRecordingLogger(records), {
      provider: "test-provider",
      model: "test-model",
      protocol: "responses",
    });

    diagnostics.requestStarted();
    diagnostics.retrying({
      attempt: 1,
      delayMs: 250,
      errorCode: "PROVIDER_HTTP_ERROR",
      errorType: "TestHttpError",
      httpStatus: 503,
    });
    diagnostics.authenticationRefreshStarted("http_401");
    diagnostics.authenticationRefreshEnded({ outcome: "refreshed" });
    diagnostics.streamRecoveryStarted({
      attempt: 2,
      delayMs: 500,
      errorCode: "PROVIDER_STREAM_TRANSIENT_ERROR",
      errorType: "ResponsesStreamError",
      eventType: "error",
      providerCode: "server_error",
    });
    diagnostics.streamRecoveryEnded(2);
    diagnostics.requestCompleted("stop");
    diagnostics.requestFailed(
      formatProviderFailure(new Error("streamed secret"), { phase: "response_stream" }),
    );

    expect(
      records.map((record) => ({
        level: record.level,
        event: record.event,
        phase: record.metadata?.phase,
        outcome: record.metadata?.outcome,
      })),
    ).toEqual([
      {
        level: "debug",
        event: "provider.request_started",
        phase: "validation",
        outcome: "started",
      },
      {
        level: "warn",
        event: "provider.retrying",
        phase: "http_request",
        outcome: "retrying",
      },
      {
        level: "info",
        event: "provider.authentication_refresh_started",
        phase: "authentication",
        outcome: "started",
      },
      {
        level: "info",
        event: "provider.authentication_refresh_ended",
        phase: "authentication",
        outcome: "refreshed",
      },
      {
        level: "warn",
        event: "provider.stream_recovery_started",
        phase: "response_stream",
        outcome: "retrying",
      },
      {
        level: "info",
        event: "provider.stream_recovery_ended",
        phase: "response_stream",
        outcome: "recovered",
      },
      {
        level: "debug",
        event: "provider.request_completed",
        phase: "response_stream",
        outcome: "completed",
      },
      {
        level: "error",
        event: "provider.request_failed",
        phase: "response_stream",
        outcome: "failed",
      },
    ]);
    expect(records.every((record) => record.metadata?.provider === "test-provider")).toBe(true);
    expect(records.every((record) => record.metadata?.model === "test-model")).toBe(true);
    expect(records.every((record) => record.metadata?.protocol === "responses")).toBe(true);
    expect(records[1]?.metadata).toMatchObject({
      attempt: 1,
      delayMs: 250,
      errorCode: "PROVIDER_HTTP_ERROR",
      errorType: "TestHttpError",
      httpStatus: 503,
    });
    expect(records[7]?.metadata).toMatchObject({
      errorCode: "PROVIDER_STREAM_ERROR",
      errorType: "Error",
    });
    expect(JSON.stringify(records)).not.toContain("streamed secret");
  });

  test("distinguishes upstream cancellation from inactivity timeout", () => {
    const controller = new AbortController();
    const reason = new Error("cancel request");
    controller.abort(reason);

    expect(
      formatProviderFailure(reason, {
        phase: "http_request",
        signal: controller.signal,
      }),
    ).toEqual({
      phase: "http_request",
      outcome: "aborted",
      errorCode: "PROVIDER_REQUEST_ABORTED",
      errorType: "Error",
    });
    expect(
      formatProviderFailure(new Error("timeout"), {
        phase: "response_stream",
        timedOut: true,
      }),
    ).toEqual({
      phase: "response_stream",
      outcome: "timed_out",
      errorCode: "PROVIDER_INACTIVITY_TIMEOUT",
      errorType: "Error",
    });
  });

  test("does not let logger failures change provider control flow", () => {
    const fail = (): never => {
      throw new Error("logger unavailable");
    };
    const logger: Logger = { debug: fail, info: fail, warn: fail, error: fail };
    const diagnostics = createProviderDiagnostics(logger, {
      provider: "test-provider",
      model: "test-model",
      protocol: "chat-completions",
    });

    expect(() => diagnostics.requestStarted()).not.toThrow();
    expect(() =>
      diagnostics.requestFailed(
        formatProviderFailure(new Error("request failed"), { phase: "validation" }),
      ),
    ).not.toThrow();
  });
});
