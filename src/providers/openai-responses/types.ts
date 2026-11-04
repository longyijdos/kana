import type { ModelMetadata } from "@/core";
import type { Logger } from "@/logging";

export type OpenAIResponsesModelConfig = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  // Extra top-level request fields; they never replace Kana-managed fields.
  requestParams?: Readonly<Record<string, unknown>>;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  metadata: Omit<ModelMetadata, "provider" | "model" | "protocol" | "assistantReplayFields">;
  reasoningEffort?: string;
  logger?: Logger;
};
