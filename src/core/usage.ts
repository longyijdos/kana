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
