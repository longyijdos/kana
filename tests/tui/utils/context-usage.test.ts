import { describe, expect, test } from "bun:test";
import { calculateContextUsedPercent } from "@/tui/utils/context-usage";

describe("TUI context usage", () => {
  test("rounds estimated tokens against the effective context limit", () => {
    expect(calculateContextUsedPercent(8_687, 256_000)).toBe(3);
    expect(calculateContextUsedPercent(123_456, 1_000_000)).toBe(12);
  });

  test("handles unavailable and out-of-range values", () => {
    expect(calculateContextUsedPercent(undefined, 256_000)).toBeUndefined();
    expect(calculateContextUsedPercent(10, 0)).toBeUndefined();
    expect(calculateContextUsedPercent(-10, 256_000)).toBe(0);
    expect(calculateContextUsedPercent(300_000, 256_000)).toBe(100);
  });
});
