import type { ModelConfig, ModelUsage, ToolCallContent } from "@/core";

export type DeepSeekReasoningEffort = "high" | "max";

export type DeepSeekToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export type DeepSeekResponseFormat =
  | {
      type: "text";
    }
  | {
      type: "json_object";
    };

export type DeepSeekModelConfig = ModelConfig & {
  provider: "deepseek";
  thinking?: boolean;
  reasoningEffort?: DeepSeekReasoningEffort;
  topP?: number;
  toolChoice?: DeepSeekToolChoice;
  responseFormat?: DeepSeekResponseFormat;
  userId?: string;
  strictTools?: boolean;
};

export type DeepSeekMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };

export type DeepSeekTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
    strict?: boolean;
  };
};

export type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type DeepSeekChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      role?: "assistant" | null;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCallDelta[];
    };
    finish_reason?: DeepSeekFinishReason | null;
  }>;
  usage?: DeepSeekUsage;
};

export type DeepSeekUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export type DeepSeekFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "insufficient_system_resource";

export type DeepSeekToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type PendingToolCall = {
  contentIndex: number;
  isNew: boolean;
  toolCall: ToolCallContent;
};

export type DeepSeekStreamState = {
  finishReason?: DeepSeekFinishReason;
  endedContentIndexes: Set<number>;
  usage?: ModelUsage;
};
