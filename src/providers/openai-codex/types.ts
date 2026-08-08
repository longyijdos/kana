import type { ModelConfig, ModelUsage } from "@/core";
import type { Logger } from "@/logging";

// Responses Lite accepts reasoning effort through max. Ultra is a Codex client
// orchestration mode and must not be sent as a provider reasoning effort.
export type OpenAICodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type OpenAICodexReasoningSummary = "auto" | "concise" | "detailed";

export type OpenAICodexCredentials = {
  accessToken: string;
  accountId: string;
};

export type OpenAICodexCredentialProvider = {
  getCredentials(): Promise<OpenAICodexCredentials | undefined>;
  refreshCredentials(): Promise<OpenAICodexCredentials | undefined>;
};

export type OpenAICodexModelConfig = ModelConfig & {
  provider: "openai-codex";
  credentialProvider: OpenAICodexCredentialProvider;
  reasoningEffort?: OpenAICodexReasoningEffort;
  reasoningSummary?: OpenAICodexReasoningSummary;
  webSearch?: boolean;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
};

export type OpenAICodexStreamState = {
  terminalSeen: boolean;
  stopReason?: "stop" | "length" | "toolUse";
  usage?: ModelUsage;
};
