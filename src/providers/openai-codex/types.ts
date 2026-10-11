import type { Logger } from "@/logging";

// OpenAI Codex Responses accepts reasoning effort through max. Ultra is a Codex client
// orchestration mode and must not be sent as a provider reasoning effort.
export type OpenAICodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type OpenAICodexReasoningSummary = "auto" | "concise" | "detailed";

export type OpenAICodexCredentials = {
  accessToken: string;
};

export type OpenAICodexCredentialProvider = {
  getCredentials(): Promise<OpenAICodexCredentials | undefined>;
  refreshCredentials(): Promise<OpenAICodexCredentials | undefined>;
};

export type OpenAICodexModelConfig = {
  provider: "openai-codex";
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  sessionId?: string;
  credentialProvider: OpenAICodexCredentialProvider;
  reasoningEffort?: OpenAICodexReasoningEffort;
  reasoningSummary?: OpenAICodexReasoningSummary;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
};
