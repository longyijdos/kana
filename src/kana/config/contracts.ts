import type { LogLevel } from "@/logging";
import type { OpenAICodexReasoningSummary } from "@/providers";

export const KANA_MODEL_PROVIDERS = ["deepseek", "openai-codex", "custom"] as const;

export type KanaModelProvider = (typeof KANA_MODEL_PROVIDERS)[number];

export type KanaDeepSeekProviderConfig = {
  apiKeyEnv: string;
  timeoutMs: number;
  maxRetries: number;
};

export type KanaOpenAICodexProviderConfig = {
  reasoningSummary: OpenAICodexReasoningSummary;
  timeoutMs: number;
  maxRetries: number;
};

export type KanaProviderConfig = {
  deepseek: KanaDeepSeekProviderConfig;
  "openai-codex": KanaOpenAICodexProviderConfig;
};

export type KanaModelConfig = {
  provider: KanaModelProvider;
  name: string;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  contextLimit?: number;
};

export type KanaRepeatedToolCallsConfig = {
  reminderThresholds: number[];
  excludedTools: string[];
};

type KanaBackgroundJobsConfig = {
  maxConcurrent: number;
};

export type KanaAgentRuntimeConfig = {
  webSearch: boolean;
  imageInput: boolean;
  maxTurns: number;
  toolDeadlineMs: number;
  parallelToolCalls: boolean;
  maxParallelToolCalls: number;
};

export type KanaAgentConfig = KanaAgentRuntimeConfig & {
  model: KanaModelConfig;
  goalMaxRounds: number;
  toolResultArtifacts: boolean;
  backgroundJobs: KanaBackgroundJobsConfig;
  repeatedToolCalls: KanaRepeatedToolCallsConfig;
};

type KanaMemoryAgentConfig = KanaAgentRuntimeConfig & {
  model: KanaModelConfig;
};

export const KANA_TOOL_APPROVAL_MODES = ["always", "unless_trusted", "never"] as const;

export type KanaToolApprovalMode = (typeof KANA_TOOL_APPROVAL_MODES)[number];

export type KanaToolApprovalConfig = {
  mode: KanaToolApprovalMode;
};

export const KANA_NOTIFICATION_BACKENDS = [
  "auto",
  "off",
  "bell",
  "osc9",
  "osc777",
  "kitty",
] as const;

export type KanaNotificationBackend = (typeof KANA_NOTIFICATION_BACKENDS)[number];

export type KanaNotificationConfig = {
  backend: KanaNotificationBackend;
  onAgentCompleted: boolean;
  onApprovalRequired: boolean;
};

export type KanaTuiConfig = {
  theme: string;
  hyperlinks: boolean;
  renderLatex: boolean;
  renderMermaid?: boolean;
  smoothTextStreaming: boolean;
  collapseLongPastes: boolean;
};

export function isKanaTuiThemeName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

type KanaMemoryConfig = {
  enabled: boolean;
  maxChars: number;
  dailyRetentionDays?: number;
  agent: KanaMemoryAgentConfig;
};

export type KanaLogLevel = LogLevel;

type KanaLoggingConfig = {
  level: KanaLogLevel;
};

export type KanaConfig = {
  provider: KanaProviderConfig;
  agent: KanaAgentConfig;
  approval: KanaToolApprovalConfig;
  notification: KanaNotificationConfig;
  tui: KanaTuiConfig;
  memory: KanaMemoryConfig;
  logging: KanaLoggingConfig;
};
