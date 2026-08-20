import type { ModelConfig, ModelMetadata, ModelUsage, ToolCallContent } from "@/core";
import type { Logger } from "@/logging";

export type OpenAICompatibleModelConfig = Omit<ModelConfig, "baseUrl"> & {
  baseUrl: string;
  metadata: Omit<ModelMetadata, "provider" | "model" | "protocol">;
  reasoningEffort?: string;
  logger?: Logger;
};

export type OpenAICompatibleChunk = {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAICompatibleToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  } | null;
  error?: unknown;
};

export type OpenAICompatibleToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type OpenAICompatibleStreamState = {
  finishReason?: string;
  endedContentIndexes: Set<number>;
  usage?: ModelUsage;
};

export type PendingOpenAICompatibleToolCall = {
  contentIndex: number;
  isNew: boolean;
  toolCall: ToolCallContent;
};
