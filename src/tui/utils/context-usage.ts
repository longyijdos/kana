export function calculateContextUsedPercent(
  estimatedTokens: number | undefined,
  contextLimit: number,
): number | undefined {
  if (estimatedTokens === undefined || contextLimit <= 0) {
    return undefined;
  }

  return Math.min(100, Math.max(0, Math.round((estimatedTokens / contextLimit) * 100)));
}
