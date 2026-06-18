import type { ModelContext } from "./context";
import type { AssistantMessage } from "./messages";
import type { ReadableAssistantEventStream } from "./stream";

export type ModelConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
};

export type ModelCost = {
  // Prices are denominated in CNY per 1M tokens.
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
};

export type ModelMetadata = {
  provider: string;
  model: string;
  cost: ModelCost;
  contextWindow: number;
  // Provider hard limit for one completion, distinct from request maxTokens.
  maxOutputTokens: number;
};

export interface Model {
  readonly metadata: ModelMetadata;

  stream(context: ModelContext): ReadableAssistantEventStream;

  generate(context: ModelContext): Promise<AssistantMessage>;
}

export abstract class BaseModel implements Model {
  abstract readonly metadata: ModelMetadata;

  abstract stream(context: ModelContext): ReadableAssistantEventStream;

  generate(context: ModelContext): Promise<AssistantMessage> {
    // Keep one behavioral path: generate is just stream collection.
    return this.stream(context).result();
  }
}
