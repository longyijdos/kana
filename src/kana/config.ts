import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { LOG_LEVELS, type LogLevel } from "@/logging";
import type {
  DeepSeekReasoningEffort,
  OpenAICodexReasoningEffort,
  OpenAICodexReasoningSummary,
} from "@/providers";
import { DEFAULT_KANA_TOOL_APPROVALS } from "./tool-approval-defaults";

export const KANA_MODEL_PROVIDERS = ["deepseek", "openai-codex"] as const;

export type KanaModelProvider = (typeof KANA_MODEL_PROVIDERS)[number];

export const KANA_DEEPSEEK_REASONING_EFFORTS = ["high", "max"] as const;

export const KANA_OPENAI_CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type KanaProviderConfig = {
  active: KanaModelProvider;
};

export type KanaDeepSeekModelConfig = {
  name: string;
  apiKeyEnv: string;
  thinking: boolean;
  reasoningEffort: DeepSeekReasoningEffort;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
};

export type KanaOpenAICodexModelConfig = {
  name: string;
  reasoningEffort: OpenAICodexReasoningEffort;
  reasoningSummary: OpenAICodexReasoningSummary;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
};

export type KanaModelConfigMap = {
  deepseek: KanaDeepSeekModelConfig;
  "openai-codex": KanaOpenAICodexModelConfig;
};

export type KanaModelConfig = KanaModelConfigMap[KanaModelProvider];

export type KanaAgentConfig = {
  maxTurns: number;
  toolDeadlineMs: number;
  parallelToolCalls: boolean;
  contextLimit?: number;
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
  smoothTextStreaming: boolean;
};

export type KanaMemoryConfig = {
  enabled: boolean;
  maxChars: number;
  dailyRetentionDays?: number;
};

export const KANA_LOG_LEVELS = LOG_LEVELS;

export type KanaLogLevel = LogLevel;

export type KanaLoggingConfig = {
  level: KanaLogLevel;
};

export type KanaConfig = {
  provider: KanaProviderConfig;
  model: KanaModelConfigMap;
  agent: KanaAgentConfig;
  approval: KanaToolApprovalConfig;
  notification: KanaNotificationConfig;
  tui: KanaTuiConfig;
  memory: KanaMemoryConfig;
  logging: KanaLoggingConfig;
};

export type KanaConfigPaths = {
  home: string;
  configPath: string;
  configExamplePath: string;
  mcpConfigPath: string;
  mcpEnabledPath: string;
  agentsPath: string;
  memoryDirectory: string;
  sessionsPath: string;
  logsPath: string;
  accountingPath: string;
  approvalsPath: string;
  skillsConfigPath: string;
};

export type InstallKanaConfigResult = {
  configPath: string;
  configStatus: "defaults" | "exists";
  configExamplePath: string;
  configExampleStatus: "created" | "exists" | "updated";
  mcpConfigPath: string;
  mcpConfigStatus: "created" | "exists";
  mcpEnabledPath: string;
  mcpEnabledStatus: "created" | "exists";
  approvalsPath: string;
  approvalsStatus: "created" | "exists";
  skillsConfigPath: string;
  skillsConfigStatus: "created" | "exists";
};

export type ResetKanaConfigResult = {
  configPath: string;
  configRemoved: boolean;
  configExamplePath: string;
  mcpConfigPath: string;
  mcpEnabledPath: string;
  approvalsPath: string;
  skillsConfigPath: string;
};

export const DEFAULT_KANA_CONFIG: KanaConfig = {
  provider: {
    active: "deepseek",
  },
  model: {
    deepseek: {
      name: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      thinking: true,
      reasoningEffort: "high",
      maxTokens: 384_000,
      timeoutMs: 60_000,
      maxRetries: 1,
    },
    "openai-codex": {
      name: "gpt-5.6-sol",
      reasoningEffort: "medium",
      reasoningSummary: "auto",
      maxTokens: 128_000,
      timeoutMs: 60_000,
      maxRetries: 1,
    },
  },
  agent: {
    maxTurns: -1,
    toolDeadlineMs: 300_000,
    parallelToolCalls: true,
    contextLimit: undefined,
  },
  approval: {
    mode: "unless_trusted",
  },
  notification: {
    backend: "auto",
    onAgentCompleted: true,
    onApprovalRequired: true,
  },
  tui: {
    smoothTextStreaming: true,
  },
  memory: {
    enabled: true,
    maxChars: 6000,
    dailyRetentionDays: undefined,
  },
  logging: {
    level: "info",
  },
};

export function getKanaConfigPaths(env: NodeJS.ProcessEnv = process.env): KanaConfigPaths {
  const home = env.KANA_HOME ?? path.join(env.HOME ?? homedir(), ".kana");

  return {
    home,
    configPath: path.join(home, "config.toml"),
    configExamplePath: path.join(home, "config.example.toml"),
    mcpConfigPath: path.join(home, "mcp.json"),
    mcpEnabledPath: path.join(home, "mcp-enabled.json"),
    agentsPath: path.join(home, "AGENTS.md"),
    memoryDirectory: path.join(home, "memory"),
    sessionsPath: path.join(home, "sessions"),
    logsPath: path.join(home, "logs"),
    accountingPath: path.join(home, "accounting"),
    approvalsPath: path.join(home, "approvals.json"),
    skillsConfigPath: path.join(home, "skills", "skills.toml"),
  };
}

export function loadKanaConfig(env: NodeJS.ProcessEnv = process.env): KanaConfig {
  const { configPath } = getKanaConfigPaths(env);

  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_KANA_CONFIG);
  }

  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown;
  return parseKanaConfig(parsed);
}

export function installKanaConfig(env: NodeJS.ProcessEnv = process.env): InstallKanaConfigResult {
  const {
    home,
    configPath,
    configExamplePath,
    mcpConfigPath,
    mcpEnabledPath,
    approvalsPath,
    skillsConfigPath,
  } = getKanaConfigPaths(env);
  mkdirSync(home, { recursive: true });

  const configExists = existsSync(configPath);

  return {
    configPath,
    configStatus: configExists ? "exists" : "defaults",
    configExamplePath,
    configExampleStatus: writeGeneratedConfigExample(configExamplePath),
    mcpConfigPath,
    mcpConfigStatus: installKanaFile(
      mcpConfigPath,
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
    ),
    mcpEnabledPath,
    mcpEnabledStatus: installKanaFile(
      mcpEnabledPath,
      `${JSON.stringify({ enabledServers: [] }, null, 2)}\n`,
    ),
    approvalsPath,
    approvalsStatus: installKanaFile(
      approvalsPath,
      `${JSON.stringify(DEFAULT_KANA_TOOL_APPROVALS, null, 2)}\n`,
    ),
    skillsConfigPath,
    skillsConfigStatus: installKanaFile(skillsConfigPath, serializeEmptySkillsConfig()),
  };
}

export function resetKanaConfig(env: NodeJS.ProcessEnv = process.env): ResetKanaConfigResult {
  const paths = getKanaConfigPaths(env);
  mkdirSync(paths.home, { recursive: true });

  // Reset touches only the explicit configuration allowlist. User data,
  // credentials, logs, AGENTS.md, and installed Skill directories stay intact.
  const configRemoved = existsSync(paths.configPath);
  rmSync(paths.configPath, { force: true });
  writeGeneratedConfigExample(paths.configExamplePath);
  writeKanaFile(paths.mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  writeKanaFile(paths.mcpEnabledPath, `${JSON.stringify({ enabledServers: [] }, null, 2)}\n`);
  writeKanaFile(paths.approvalsPath, `${JSON.stringify(DEFAULT_KANA_TOOL_APPROVALS, null, 2)}\n`);
  writeKanaFile(paths.skillsConfigPath, serializeEmptySkillsConfig());

  return {
    configPath: paths.configPath,
    configRemoved,
    configExamplePath: paths.configExamplePath,
    mcpConfigPath: paths.mcpConfigPath,
    mcpEnabledPath: paths.mcpEnabledPath,
    approvalsPath: paths.approvalsPath,
    skillsConfigPath: paths.skillsConfigPath,
  };
}

export function parseKanaConfig(rawConfig: unknown): KanaConfig {
  return mergeKanaConfig(DEFAULT_KANA_CONFIG, rawConfig);
}

export function validateKanaConfig(config: KanaConfig): KanaConfig {
  return parseKanaConfig({
    provider: {
      active: config.provider.active,
    },
    model: {
      deepseek: {
        name: config.model.deepseek.name,
        api_key_env: config.model.deepseek.apiKeyEnv,
        thinking: config.model.deepseek.thinking,
        reasoning_effort: config.model.deepseek.reasoningEffort,
        max_tokens: config.model.deepseek.maxTokens,
        timeout_ms: config.model.deepseek.timeoutMs,
        max_retries: config.model.deepseek.maxRetries,
      },
      "openai-codex": {
        name: config.model["openai-codex"].name,
        reasoning_effort: config.model["openai-codex"].reasoningEffort,
        reasoning_summary: config.model["openai-codex"].reasoningSummary,
        max_tokens: config.model["openai-codex"].maxTokens,
        timeout_ms: config.model["openai-codex"].timeoutMs,
        max_retries: config.model["openai-codex"].maxRetries,
      },
    },
    agent: {
      max_turns: config.agent.maxTurns,
      tool_deadline_ms: config.agent.toolDeadlineMs,
      parallel_tool_calls: config.agent.parallelToolCalls,
      context_limit: config.agent.contextLimit,
    },
    approval: {
      mode: config.approval.mode,
    },
    notification: {
      backend: config.notification.backend,
      on_agent_completed: config.notification.onAgentCompleted,
      on_approval_required: config.notification.onApprovalRequired,
    },
    tui: {
      smooth_text_streaming: config.tui.smoothTextStreaming,
    },
    memory: {
      enabled: config.memory.enabled,
      max_chars: config.memory.maxChars,
      daily_retention_days: config.memory.dailyRetentionDays,
    },
    logging: {
      level: config.logging.level,
    },
  });
}

function serializeKanaConfigExample(config: KanaConfig): string {
  return [
    "# Generated configuration reference. Kana does not read this file.",
    "# Copy only the settings you want to override into config.toml.",
    "",
    "[provider]",
    `active = "${config.provider.active}"`,
    "",
    "[model.deepseek]",
    `name = "${config.model.deepseek.name}"`,
    ...serializeDeepSeekModel(config.model.deepseek),
    "",
    "[model.openai-codex]",
    `name = "${config.model["openai-codex"].name}"`,
    ...serializeOpenAICodexModel(config.model["openai-codex"]),
    "",
    "[agent]",
    `max_turns = ${config.agent.maxTurns}`,
    `tool_deadline_ms = ${config.agent.toolDeadlineMs}`,
    `parallel_tool_calls = ${config.agent.parallelToolCalls}`,
    "# context_limit = 200000",
    "",
    "[approval]",
    `mode = "${config.approval.mode}"`,
    "",
    "[notification]",
    `backend = "${config.notification.backend}"`,
    `on_agent_completed = ${config.notification.onAgentCompleted}`,
    `on_approval_required = ${config.notification.onApprovalRequired}`,
    "",
    "[tui]",
    `smooth_text_streaming = ${config.tui.smoothTextStreaming}`,
    "",
    "[memory]",
    `enabled = ${config.memory.enabled}`,
    `max_chars = ${config.memory.maxChars}`,
    "# daily_retention_days = 30",
    "",
    "[logging]",
    `level = "${config.logging.level}"`,
    "",
  ].join("\n");
}

function installKanaFile(filePath: string, content: string): "created" | "exists" {
  if (existsSync(filePath)) {
    return "exists";
  }

  writeKanaFile(filePath, content);
  return "created";
}

function writeGeneratedConfigExample(
  configExamplePath: string,
): InstallKanaConfigResult["configExampleStatus"] {
  const content = serializeKanaConfigExample(DEFAULT_KANA_CONFIG);
  if (!existsSync(configExamplePath)) {
    writeKanaFile(configExamplePath, content);
    return "created";
  }
  if (readFileSync(configExamplePath, "utf8") === content) {
    return "exists";
  }

  // The example is generated reference material rather than user configuration,
  // so refreshing it is safe and keeps upgrades aligned with the current schema.
  writeKanaFile(configExamplePath, content);
  return "updated";
}

function writeKanaFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function serializeEmptySkillsConfig(): string {
  return ["[model_invocation]", "enabled = []", ""].join("\n");
}

function mergeKanaConfig(defaults: KanaConfig, rawConfig: unknown): KanaConfig {
  const raw = asRecord(rawConfig, "config");
  const provider = raw.provider === undefined ? {} : asRecord(raw.provider, "provider");
  const model = raw.model === undefined ? {} : asRecord(raw.model, "model");
  const legacyModel = isLegacyModelConfig(model) ? model : undefined;
  const activeProvider = readModelProvider(
    provider.active ?? legacyModel?.provider,
    defaults.provider.active,
  );
  const deepSeekModel =
    legacyModel?.provider === undefined || legacyModel.provider === "deepseek"
      ? (legacyModel ?? readModelTable(model, "deepseek"))
      : readModelTable(model, "deepseek");
  const openAICodexModel = readModelTable(model, "openai-codex");
  const agent = raw.agent === undefined ? {} : asRecord(raw.agent, "agent");
  const approval = raw.approval === undefined ? {} : asRecord(raw.approval, "approval");
  const notification =
    raw.notification === undefined ? {} : asRecord(raw.notification, "notification");
  const tui = raw.tui === undefined ? {} : asRecord(raw.tui, "tui");
  const memory = raw.memory === undefined ? {} : asRecord(raw.memory, "memory");
  const logging = raw.logging === undefined ? {} : asRecord(raw.logging, "logging");

  return {
    provider: {
      active: activeProvider,
    },
    model: {
      deepseek: {
        name: readString(deepSeekModel.name, defaults.model.deepseek.name, "model.deepseek.name"),
        apiKeyEnv: readString(
          deepSeekModel.api_key_env,
          defaults.model.deepseek.apiKeyEnv,
          "model.deepseek.api_key_env",
        ),
        thinking: readBoolean(
          deepSeekModel.thinking,
          defaults.model.deepseek.thinking,
          "model.deepseek.thinking",
        ),
        reasoningEffort: readDeepSeekReasoningEffort(
          deepSeekModel.reasoning_effort,
          defaults.model.deepseek.reasoningEffort,
        ),
        maxTokens: readPositiveInteger(
          deepSeekModel.max_tokens,
          defaults.model.deepseek.maxTokens,
          "model.deepseek.max_tokens",
        ),
        timeoutMs: readNumber(
          deepSeekModel.timeout_ms,
          defaults.model.deepseek.timeoutMs,
          "model.deepseek.timeout_ms",
        ),
        maxRetries: readNumber(
          deepSeekModel.max_retries,
          defaults.model.deepseek.maxRetries,
          "model.deepseek.max_retries",
        ),
      },
      "openai-codex": {
        name: readString(
          openAICodexModel.name,
          defaults.model["openai-codex"].name,
          "model.openai-codex.name",
        ),
        reasoningEffort: readOpenAICodexReasoningEffort(
          openAICodexModel.reasoning_effort,
          defaults.model["openai-codex"].reasoningEffort,
        ),
        reasoningSummary: readOpenAICodexReasoningSummary(
          openAICodexModel.reasoning_summary,
          defaults.model["openai-codex"].reasoningSummary,
        ),
        maxTokens: readPositiveInteger(
          openAICodexModel.max_tokens,
          defaults.model["openai-codex"].maxTokens,
          "model.openai-codex.max_tokens",
        ),
        timeoutMs: readNumber(
          openAICodexModel.timeout_ms,
          defaults.model["openai-codex"].timeoutMs,
          "model.openai-codex.timeout_ms",
        ),
        maxRetries: readNumber(
          openAICodexModel.max_retries,
          defaults.model["openai-codex"].maxRetries,
          "model.openai-codex.max_retries",
        ),
      },
    },
    agent: {
      maxTurns: readAgentMaxTurns(agent.max_turns, defaults.agent.maxTurns, "agent.max_turns"),
      toolDeadlineMs: readPositiveInteger(
        agent.tool_deadline_ms,
        defaults.agent.toolDeadlineMs,
        "agent.tool_deadline_ms",
      ),
      parallelToolCalls: readBoolean(
        agent.parallel_tool_calls,
        defaults.agent.parallelToolCalls,
        "agent.parallel_tool_calls",
      ),
      contextLimit: readOptionalPositiveInteger(
        agent.context_limit,
        defaults.agent.contextLimit,
        "agent.context_limit",
      ),
    },
    approval: {
      mode: readToolApprovalMode(approval.mode, defaults.approval.mode),
    },
    notification: {
      backend: readNotificationBackend(notification.backend, defaults.notification.backend),
      onAgentCompleted: readBoolean(
        notification.on_agent_completed,
        defaults.notification.onAgentCompleted,
        "notification.on_agent_completed",
      ),
      onApprovalRequired: readBoolean(
        notification.on_approval_required,
        defaults.notification.onApprovalRequired,
        "notification.on_approval_required",
      ),
    },
    tui: {
      smoothTextStreaming: readBoolean(
        tui.smooth_text_streaming,
        defaults.tui.smoothTextStreaming,
        "tui.smooth_text_streaming",
      ),
    },
    memory: {
      enabled: readBoolean(memory.enabled, defaults.memory.enabled, "memory.enabled"),
      maxChars: readPositiveInteger(memory.max_chars, defaults.memory.maxChars, "memory.max_chars"),
      dailyRetentionDays: readOptionalPositiveInteger(
        memory.daily_retention_days,
        defaults.memory.dailyRetentionDays,
        "memory.daily_retention_days",
      ),
    },
    logging: {
      level: readLogLevel(logging.level, defaults.logging.level),
    },
  };
}

export function getActiveKanaModelConfig<TProvider extends KanaModelProvider>(
  config: KanaConfig & { provider: { active: TProvider } },
): KanaModelConfigMap[TProvider] {
  return config.model[config.provider.active];
}

function serializeDeepSeekModel(config: KanaDeepSeekModelConfig): string[] {
  return [
    `api_key_env = "${config.apiKeyEnv}"`,
    `thinking = ${config.thinking}`,
    `reasoning_effort = "${config.reasoningEffort}"`,
    `max_tokens = ${config.maxTokens}`,
    `timeout_ms = ${config.timeoutMs}`,
    `max_retries = ${config.maxRetries}`,
  ];
}

function serializeOpenAICodexModel(config: KanaOpenAICodexModelConfig): string[] {
  return [
    `reasoning_effort = "${config.reasoningEffort}"`,
    `reasoning_summary = "${config.reasoningSummary}"`,
    `max_tokens = ${config.maxTokens}`,
    `timeout_ms = ${config.timeoutMs}`,
    `max_retries = ${config.maxRetries}`,
  ];
}

function isLegacyModelConfig(model: Record<string, unknown>): boolean {
  return (
    model.provider !== undefined ||
    model.name !== undefined ||
    model.api_key_env !== undefined ||
    model.max_tokens !== undefined
  );
}

function readModelTable(
  model: Record<string, unknown>,
  provider: KanaModelProvider,
): Record<string, unknown> {
  const value = model[provider];
  return value === undefined ? {} : asRecord(value, `model.${provider}`);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a TOML table.`);
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return value;
}

function readBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }

  return value;
}

function readNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }

  return value;
}

function readPositiveInteger(value: unknown, fallback: number, name: string): number {
  const number = readNumber(value, fallback, name);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return number;
}

function readAgentMaxTurns(value: unknown, fallback: number, name: string): number {
  const number = readNumber(value, fallback, name);

  if (number !== -1 && (!Number.isInteger(number) || number <= 0)) {
    throw new Error(`${name} must be -1 or a positive integer.`);
  }

  return number;
}

function readOptionalPositiveInteger(
  value: unknown,
  fallback: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function readModelProvider(value: unknown, fallback: KanaModelProvider): KanaModelProvider {
  const provider = readString(value, fallback, "provider.active");

  if (!(KANA_MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`provider.active must be one of: ${KANA_MODEL_PROVIDERS.join(", ")}.`);
  }

  return provider as KanaModelProvider;
}

function readDeepSeekReasoningEffort(
  value: unknown,
  fallback: DeepSeekReasoningEffort,
): DeepSeekReasoningEffort {
  const effort = readString(value, fallback, "model.deepseek.reasoning_effort");

  if (!(KANA_DEEPSEEK_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`model.deepseek.reasoning_effort must be "high" or "max".`);
  }

  return effort as DeepSeekReasoningEffort;
}

function readOpenAICodexReasoningEffort(
  value: unknown,
  fallback: OpenAICodexReasoningEffort,
): OpenAICodexReasoningEffort {
  const effort = readString(value, fallback, "model.openai-codex.reasoning_effort");
  if (!(KANA_OPENAI_CODEX_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `model.openai-codex.reasoning_effort must be one of: ${KANA_OPENAI_CODEX_REASONING_EFFORTS.join(", ")}.`,
    );
  }

  return effort as OpenAICodexReasoningEffort;
}

function readOpenAICodexReasoningSummary(
  value: unknown,
  fallback: OpenAICodexReasoningSummary,
): OpenAICodexReasoningSummary {
  const summary = readString(value, fallback, "model.openai-codex.reasoning_summary");
  const summaries = ["auto", "concise", "detailed"] as const;

  if (!(summaries as readonly string[]).includes(summary)) {
    throw new Error(
      `model.openai-codex.reasoning_summary must be one of: ${summaries.join(", ")}.`,
    );
  }

  return summary as OpenAICodexReasoningSummary;
}

function readToolApprovalMode(
  value: unknown,
  fallback: KanaToolApprovalMode,
): KanaToolApprovalMode {
  const mode = readString(value, fallback, "approval.mode");

  if (!(KANA_TOOL_APPROVAL_MODES as readonly string[]).includes(mode)) {
    throw new Error(`approval.mode must be one of: ${KANA_TOOL_APPROVAL_MODES.join(", ")}.`);
  }

  return mode as KanaToolApprovalMode;
}

function readNotificationBackend(
  value: unknown,
  fallback: KanaNotificationBackend,
): KanaNotificationBackend {
  const backend = readString(value, fallback, "notification.backend");

  if (!(KANA_NOTIFICATION_BACKENDS as readonly string[]).includes(backend)) {
    throw new Error(
      `notification.backend must be one of: ${KANA_NOTIFICATION_BACKENDS.join(", ")}.`,
    );
  }

  return backend as KanaNotificationBackend;
}

function readLogLevel(value: unknown, fallback: KanaLogLevel): KanaLogLevel {
  const level = readString(value, fallback, "logging.level");

  if (!(KANA_LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`logging.level must be one of: ${KANA_LOG_LEVELS.join(", ")}.`);
  }

  return level as KanaLogLevel;
}
