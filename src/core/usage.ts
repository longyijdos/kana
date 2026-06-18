import type { Message } from "./messages";
import type { ModelCost, ModelUsage } from "./model";

const TOKENS_PER_PRICE_UNIT = 1_000_000;

export function calculateUsageCostCny(usage: ModelUsage, cost: ModelCost): number {
  const { inputTokens, cacheReadTokens } = splitPromptTokensByCache(usage);

  return (
    (inputTokens * cost.input +
      cacheReadTokens * cost.cacheRead +
      usage.completionTokens * cost.output) /
    TOKENS_PER_PRICE_UNIT
  );
}

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

export function calculateContextUsedPercent(
  usage: ModelUsage | undefined,
  contextWindow: number,
): number | undefined {
  if (!usage || contextWindow <= 0) {
    return undefined;
  }

  return Math.min(100, Math.max(0, Math.round((usage.promptTokens / contextWindow) * 100)));
}

export function findLatestAssistantUsage(messages: Message[]): ModelUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "assistant" && message.usage) {
      return message.usage;
    }
  }

  return undefined;
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

function splitPromptTokensByCache(usage: ModelUsage): {
  inputTokens: number;
  cacheReadTokens: number;
} {
  const cacheHitTokens = usage.promptCacheHitTokens;
  const cacheMissTokens = usage.promptCacheMissTokens;

  if (cacheHitTokens !== undefined && cacheMissTokens !== undefined) {
    return {
      inputTokens: cacheMissTokens,
      cacheReadTokens: cacheHitTokens,
    };
  }

  if (cacheHitTokens !== undefined) {
    return {
      inputTokens: Math.max(0, usage.promptTokens - cacheHitTokens),
      cacheReadTokens: cacheHitTokens,
    };
  }

  if (cacheMissTokens !== undefined) {
    return {
      inputTokens: cacheMissTokens,
      cacheReadTokens: Math.max(0, usage.promptTokens - cacheMissTokens),
    };
  }

  return {
    inputTokens: usage.promptTokens,
    cacheReadTokens: 0,
  };
}
