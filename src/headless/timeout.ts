const MAX_HEADLESS_TIMEOUT_MS = 2_147_483_647;

const TIMEOUT_UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

export function parseHeadlessTimeout(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/i.exec(value.trim());
  if (!match) {
    throw new Error("Timeout must be a duration such as 500ms, 30s, 30m, or 2h.");
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() as keyof typeof TIMEOUT_UNIT_MS;
  const timeoutMs = amount * TIMEOUT_UNIT_MS[unit];
  assertValidHeadlessTimeoutMs(timeoutMs);
  return timeoutMs;
}

export function assertValidHeadlessTimeoutMs(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) {
    return;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_HEADLESS_TIMEOUT_MS) {
    throw new Error(`Timeout must resolve to between 1ms and ${MAX_HEADLESS_TIMEOUT_MS}ms.`);
  }
}
