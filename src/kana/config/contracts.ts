import type { AgentConfig } from "@/agent";
import type { LogLevel } from "@/logging";
import type { OpenAICodexReasoningSummary } from "@/providers";
import type { KanaConfigurableBuiltInToolName } from "../tool-names";

export const KANA_MODEL_PROVIDERS = ["deepseek", "openai-codex", "custom"] as const;

export type KanaModelProvider = (typeof KANA_MODEL_PROVIDERS)[number];

export type KanaDeepSeekProviderConfig = {
  readonly apiKeyEnv: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
};

export type KanaOpenAICodexProviderConfig = {
  readonly reasoningSummary: OpenAICodexReasoningSummary;
  readonly timeoutMs: number;
  readonly maxRetries: number;
};

export type KanaProviderConfig = {
  readonly deepseek: KanaDeepSeekProviderConfig;
  readonly "openai-codex": KanaOpenAICodexProviderConfig;
};

export type KanaModelConfig = {
  readonly provider: KanaModelProvider;
  readonly name: string;
  readonly reasoningEffort?: string;
  readonly maxOutputTokens?: number;
  readonly contextLimit?: number;
};

export type KanaRepeatedToolCallsConfig = {
  readonly reminderThresholds: readonly number[];
  readonly excludedTools: readonly string[];
};

type KanaBackgroundJobsConfig = {
  readonly maxConcurrent: number;
};

type KanaSubagentsConfig = {
  readonly maxLive: number;
};

export type KanaAgentRuntimeConfig = {
  readonly webSearch: boolean;
  readonly imageInput: boolean;
  readonly maxTurns: number;
  readonly toolDeadlineMs: number;
  readonly parallelToolCalls: boolean;
  readonly maxParallelToolCalls: number;
};

export type KanaAgentConfig = KanaAgentRuntimeConfig & {
  readonly codemode: NonNullable<AgentConfig["codemode"]>;
  readonly model: KanaModelConfig;
  readonly tools: readonly KanaConfigurableBuiltInToolName[];
  readonly goalMaxRounds: number;
  readonly toolResultArtifacts: boolean;
  readonly backgroundJobs: KanaBackgroundJobsConfig;
  readonly subagents: KanaSubagentsConfig;
  readonly repeatedToolCalls: KanaRepeatedToolCallsConfig;
};

type KanaModelConfigOverride = Partial<KanaModelConfig>;

type KanaMemoryAgentConfig = KanaAgentRuntimeConfig & {
  readonly model: KanaModelConfigOverride;
};

export const KANA_TOOL_APPROVAL_MODES = ["always", "unless_trusted", "never"] as const;

export type KanaToolApprovalMode = (typeof KANA_TOOL_APPROVAL_MODES)[number];

export type KanaToolApprovalConfig = {
  readonly mode: KanaToolApprovalMode;
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
  readonly backend: KanaNotificationBackend;
  readonly onAgentCompleted: boolean;
  readonly onApprovalRequired: boolean;
};

export type KanaTuiConfig = {
  readonly theme: string;
  readonly hyperlinks: boolean;
  readonly renderLatex: boolean;
  readonly renderMermaid: boolean;
  readonly smoothTextStreaming: boolean;
  readonly collapseLongPastes: boolean;
};

export const KANA_TUI_THEME_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";

export function isKanaTuiThemeName(value: string): boolean {
  return new RegExp(KANA_TUI_THEME_NAME_PATTERN).test(value);
}

type KanaMemoryConfig = {
  readonly enabled: boolean;
  readonly maxChars: number;
  readonly dailyRetentionDays?: number;
  readonly agent: KanaMemoryAgentConfig;
};

type KanaLoggingConfig = {
  readonly level: LogLevel;
};

export type KanaConfig = {
  readonly provider: KanaProviderConfig;
  readonly agent: KanaAgentConfig;
  readonly approval: KanaToolApprovalConfig;
  readonly notification: KanaNotificationConfig;
  readonly tui: KanaTuiConfig;
  readonly memory: KanaMemoryConfig;
  readonly logging: KanaLoggingConfig;
};

// A mutable copy handed to KanaConfigStore.update callbacks.
export type KanaConfigDraft = DeepMutable<KanaConfig>;

type DeepMutable<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
