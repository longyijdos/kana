export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
};

export function addModelUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    promptTokens: (current?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (current?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    promptCacheHitTokens: addOptionalUsageTokens(
      current?.promptCacheHitTokens,
      next.promptCacheHitTokens,
    ),
    promptCacheMissTokens: addOptionalUsageTokens(
      current?.promptCacheMissTokens,
      next.promptCacheMissTokens,
    ),
    reasoningTokens: addOptionalUsageTokens(current?.reasoningTokens, next.reasoningTokens),
  };
}

function addOptionalUsageTokens(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  if (current === undefined && next === undefined) {
    return undefined;
  }

  return (current ?? 0) + (next ?? 0);
}
