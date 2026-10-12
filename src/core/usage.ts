import { Type } from "typebox";

export type ModelUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
  readonly reasoningTokens?: number;
};

const tokenCount = Type.Integer({ minimum: 0 });

export const MODEL_USAGE_SCHEMA = Type.Object({
  promptTokens: tokenCount,
  completionTokens: tokenCount,
  totalTokens: tokenCount,
  promptCacheHitTokens: Type.Optional(tokenCount),
  promptCacheMissTokens: Type.Optional(tokenCount),
  reasoningTokens: Type.Optional(tokenCount),
});

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
