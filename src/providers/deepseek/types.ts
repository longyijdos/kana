import type { Logger } from "@/logging";

export type DeepSeekReasoningEffort = "none" | "low" | "high" | "max";

export type DeepSeekModelConfig = {
  provider: "deepseek";
  model: string;
  apiKey: string;
  baseUrl?: string;
  reasoningEffort?: DeepSeekReasoningEffort;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: Logger;
};
