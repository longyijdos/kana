import type { ModelConfig } from "@/core";
import type { Logger } from "@/logging";

export type DeepSeekReasoningEffort = "low" | "high" | "max";

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

type DeepSeekResponseFormat =
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
  webSearch?: boolean;
  imageInput?: boolean;
  topP?: number;
  toolChoice?: DeepSeekToolChoice;
  responseFormat?: DeepSeekResponseFormat;
  userId?: string;
  strictTools?: boolean;
  logger?: Logger;
};
