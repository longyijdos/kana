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

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
};

type ModelProtocol = "chat-completions" | "responses";

export type ModelMetadata = {
  provider: string;
  model: string;
  // Shared wire codec used by the provider adapter. In-process or fully
  // provider-specific implementations use null.
  protocol: ModelProtocol | null;
  contextWindow: number;
  // Provider hard limit for one completion, distinct from request maxTokens.
  maxOutputTokens: number;
  // Capability of the concrete model and wire protocol, not only the provider.
  supportsParallelToolCalls: boolean;
  // Provider/model capability only; provider configuration may still disable it.
  supportsHostedWebSearch: boolean;
  // Input modality capability only; provider configuration may still disable it.
  // Omitted capabilities are treated as unsupported for compatibility with
  // in-process models that predate image inputs.
  supportsImageInput?: boolean;
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
