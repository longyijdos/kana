import { describe, expect, test } from "bun:test";
import { isContextWindowFailure, readOpenAIErrorSignals } from "../../src/providers/context-window";

describe("provider context-window classification", () => {
  test("recognizes shared structured and plain-text signals only for eligible statuses", () => {
    const structured = readOpenAIErrorSignals(
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "Request cannot be processed.",
        },
      }),
    );

    expect(isContextWindowFailure({ status: 400, ...structured })).toBe(true);
    expect(
      isContextWindowFailure({
        status: 413,
        message: "The prompt token length is too large.",
      }),
    ).toBe(true);
    expect(isContextWindowFailure({ status: 500, ...structured })).toBe(false);
    expect(
      isContextWindowFailure({ status: 400, code: "invalid_request", message: "Bad temperature" }),
    ).toBe(false);
  });

  test("allows a provider signal without enabling common message matches", () => {
    expect(
      isContextWindowFailure({
        status: 422,
        message: "Maximum context length",
        includeCommonMessageSignals: false,
        providerSignal: true,
      }),
    ).toBe(true);
    expect(
      isContextWindowFailure({
        status: 422,
        message: "Maximum context length",
        includeCommonMessageSignals: false,
      }),
    ).toBe(false);
  });
});
