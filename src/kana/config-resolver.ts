import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from "@/agent";
import type { ModelMetadata } from "@/core";
import { LOG_LEVELS, type LogLevel } from "@/logging";
import {
  DEEPSEEK_MODELS,
  type DeepSeekReasoningEffort,
  OPENAI_CODEX_MODELS,
  type OpenAICodexReasoningEffort,
  type OpenAICodexReasoningSummary,
} from "@/providers";
import { DEFAULT_KANA_GOAL_MAX_ROUNDS } from "./conversation/goal-controller";
import {
  getKanaCustomProviderModel,
  type KanaCustomProvider,
  resolveKanaCustomReasoning,
} from "./custom-provider";

export const KANA_MODEL_PROVIDERS = ["deepseek", "openai-codex", "custom"] as const;
export type KanaModelProvider = (typeof KANA_MODEL_PROVIDERS)[number];

const KANA_DEEPSEEK_REASONING_EFFORTS = ["none", "low", "high", "max"] as const;
const KANA_OPENAI_CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type KanaDeepSeekModelConfig = {
  reasoningEffort: DeepSeekReasoningEffort;
  webSearch: boolean;
  imageInput: boolean;
  maxOutputTokens: number;
  contextLimit: number;
};

export type KanaOpenAICodexModelConfig = {
  reasoningEffort: OpenAICodexReasoningEffort;
  reasoningSummary: OpenAICodexReasoningSummary;
  webSearch: boolean;
  imageInput: boolean;
  maxOutputTokens: number;
  contextLimit: number;
};

type KanaModelConfigMap = {
  deepseek: Record<string, KanaDeepSeekModelConfig>;
  "openai-codex": Record<string, KanaOpenAICodexModelConfig>;
};

const DEFAULT_DEEPSEEK_MODEL_CONFIG = {
  "deepseek-v4-flash": {
    reasoningEffort: "high",
    webSearch: true,
    imageInput: false,
    maxOutputTokens: 384_000,
    contextLimit: 1_000_000,
  },
  "deepseek-v4-flash-vision-exp": {
    reasoningEffort: "high",
    webSearch: true,
    imageInput: true,
    maxOutputTokens: 384_000,
    contextLimit: 1_000_000,
  },
  "deepseek-v4-pro": {
    reasoningEffort: "high",
    webSearch: true,
    imageInput: false,
    maxOutputTokens: 384_000,
    contextLimit: 1_000_000,
  },
} satisfies Record<keyof typeof DEEPSEEK_MODELS, KanaDeepSeekModelConfig>;

const DEFAULT_OPENAI_CODEX_MODEL_CONFIG = {
  "gpt-5.6-sol": {
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    webSearch: true,
    imageInput: true,
    maxOutputTokens: 128_000,
    contextLimit: 372_000,
  },
  "gpt-5.6-terra": {
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    webSearch: true,
    imageInput: true,
    maxOutputTokens: 128_000,
    contextLimit: 372_000,
  },
  "gpt-5.6-luna": {
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    webSearch: true,
    imageInput: true,
    maxOutputTokens: 128_000,
    contextLimit: 372_000,
  },
} satisfies Record<keyof typeof OPENAI_CODEX_MODELS, KanaOpenAICodexModelConfig>;

type ResolvedKanaModelCommon = {
  model: string;
  webSearch: boolean;
  imageInput: boolean;
  maxOutputTokens: number;
  contextLimit: number;
  timeoutMs: number;
  maxRetries: number;
};

type ResolvedKanaDeepSeekModelConfig = ResolvedKanaModelCommon & {
  provider: "deepseek";
  apiKeyEnv: string;
  reasoningEffort: DeepSeekReasoningEffort;
};

type ResolvedKanaOpenAICodexModelConfig = ResolvedKanaModelCommon & {
  provider: "openai-codex";
  reasoningEffort: OpenAICodexReasoningEffort;
  reasoningSummary: OpenAICodexReasoningSummary;
};

type ResolvedKanaCustomModelConfig = ResolvedKanaModelCommon & {
  provider: "custom";
  baseUrl: string;
  apiKeyEnv?: string;
  metadata: Omit<ModelMetadata, "provider" | "model" | "protocol">;
  reasoningEffort?: string;
  providerConfigPath: string;
};

export type ResolvedKanaModelConfig =
  | ResolvedKanaDeepSeekModelConfig
  | ResolvedKanaOpenAICodexModelConfig
  | ResolvedKanaCustomModelConfig;

type ResolvedKanaAgentRuntimeConfig = {
  model: ResolvedKanaModelConfig;
  maxTurns: number;
  toolDeadlineMs: number;
  parallelToolCalls: boolean;
  maxParallelToolCalls: number;
};

export type KanaRepeatedToolCallsConfig = {
  reminderThresholds: number[];
  excludedTools: string[];
};

export type ResolvedKanaMainAgentConfig = ResolvedKanaAgentRuntimeConfig & {
  toolResultArtifacts: boolean;
  repeatedToolCalls: KanaRepeatedToolCallsConfig;
  memoryEnabled: boolean;
};

type ResolvedKanaMemoryAgentConfig = ResolvedKanaAgentRuntimeConfig;

export type ResolvedKanaMemoryConfig = {
  enabled: boolean;
  maxChars: number;
  dailyRetentionDays?: number;
  agent: ResolvedKanaMemoryAgentConfig;
};

const KANA_TOOL_APPROVAL_MODES = ["always", "unless_trusted", "never"] as const;
export type KanaToolApprovalMode = (typeof KANA_TOOL_APPROVAL_MODES)[number];
export type KanaToolApprovalConfig = { mode: KanaToolApprovalMode };

const KANA_NOTIFICATION_BACKENDS = ["auto", "off", "bell", "osc9", "osc777", "kitty"] as const;
export type KanaNotificationBackend = (typeof KANA_NOTIFICATION_BACKENDS)[number];
export type KanaNotificationConfig = {
  backend: KanaNotificationBackend;
  onAgentCompleted: boolean;
  onApprovalRequired: boolean;
};

export type KanaTuiConfig = {
  hyperlinks: boolean;
  renderLatex: boolean;
  renderMermaid: boolean;
  smoothTextStreaming: boolean;
  collapseLongPastes: boolean;
};

export type KanaMainAgentModelSelection = {
  provider: KanaModelProvider;
  model: string;
  reasoningEffort?: string;
};

export type ResolvedKanaConfig = {
  provider: {
    deepseek: { apiKeyEnv: string; timeoutMs: number; maxRetries: number };
    "openai-codex": { timeoutMs: number; maxRetries: number };
  };
  model: KanaModelConfigMap;
  agent: ResolvedKanaMainAgentConfig;
  memory: ResolvedKanaMemoryConfig;
  goal: { maxRounds: number };
  backgroundJobs: { maxConcurrent: number };
  approval: KanaToolApprovalConfig;
  notification: KanaNotificationConfig;
  tui: KanaTuiConfig;
  logging: { level: LogLevel };
};

export type ResolveKanaConfigOptions = {
  customProviderPath: string;
  loadCustomProvider(): KanaCustomProvider;
};

const MAIN_AGENT_KEYS = [
  "provider",
  "model",
  "max_turns",
  "tool_deadline_ms",
  "parallel_tool_calls",
  "max_parallel_tool_calls",
  "tool_result_artifacts",
  "repeated_tool_calls",
  "reasoning_effort",
  "reasoning_summary",
  "web_search",
  "image_input",
  "max_output_tokens",
  "context_limit",
] as const;

const MEMORY_AGENT_KEYS = MAIN_AGENT_KEYS.filter(
  (key) => key !== "tool_result_artifacts" && key !== "repeated_tool_calls",
);

const DEFAULT_AGENT_RUNTIME = {
  maxTurns: -1,
  // Keep the outer deadline above bash's ten-minute ceiling so bash can
  // terminate the process tree and report its own timeout result.
  toolDeadlineMs: 11 * 60 * 1000,
  parallelToolCalls: true,
  maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
};

export function resolveKanaConfig(
  rawConfig: unknown,
  options: ResolveKanaConfigOptions,
): ResolvedKanaConfig {
  const raw = asRecord(rawConfig, "config");
  const rawProvider = optionalRecord(raw.provider, "provider");
  const rawModel = optionalRecord(raw.model, "model");
  assertKnownKeys(rawProvider, ["deepseek", "openai-codex"], "provider");
  assertKnownKeys(rawModel, ["deepseek", "openai-codex"], "model");

  const provider = resolveProviderConfig(rawProvider);
  const model = resolveModelConfig(rawModel);
  const memoryTable = optionalRecord(raw.memory, "memory");
  assertKnownKeys(memoryTable, ["enabled", "max_chars", "daily_retention_days", "agent"], "memory");

  let customProvider: KanaCustomProvider | undefined;
  const loadCustomProvider = (): KanaCustomProvider => {
    customProvider ??= options.loadCustomProvider();
    return customProvider;
  };
  const modelContext: ResolveModelContext = {
    provider,
    model,
    customProviderPath: options.customProviderPath,
    loadCustomProvider,
  };

  const memoryEnabled = readBoolean(memoryTable.enabled, true, "memory.enabled");
  const agent = resolveMainAgent(optionalRecord(raw.agent, "agent"), modelContext, memoryEnabled);
  const memory = {
    enabled: memoryEnabled,
    maxChars: readPositiveInteger(memoryTable.max_chars, 6000, "memory.max_chars"),
    dailyRetentionDays: readOptionalPositiveInteger(
      memoryTable.daily_retention_days,
      undefined,
      "memory.daily_retention_days",
    ),
    agent: resolveMemoryAgent(optionalRecord(memoryTable.agent, "memory.agent"), modelContext),
  };
  const goal = optionalRecord(raw.goal, "goal");
  assertKnownKeys(goal, ["max_rounds"], "goal");
  const backgroundJobs = optionalRecord(raw.background_jobs, "background_jobs");
  assertKnownKeys(backgroundJobs, ["max_concurrent"], "background_jobs");
  const approval = optionalRecord(raw.approval, "approval");
  const notification = optionalRecord(raw.notification, "notification");
  const tui = optionalRecord(raw.tui, "tui");
  const logging = optionalRecord(raw.logging, "logging");
  assertKnownKeys(approval, ["mode"], "approval");
  assertKnownKeys(
    notification,
    ["backend", "on_agent_completed", "on_approval_required"],
    "notification",
  );
  assertKnownKeys(
    tui,
    [
      "hyperlinks",
      "render_latex",
      "render_mermaid",
      "smooth_text_streaming",
      "collapse_long_pastes",
    ],
    "tui",
  );
  assertKnownKeys(logging, ["level"], "logging");

  return {
    provider,
    model,
    agent,
    memory,
    goal: {
      maxRounds: readPositiveInteger(
        goal.max_rounds,
        DEFAULT_KANA_GOAL_MAX_ROUNDS,
        "goal.max_rounds",
      ),
    },
    backgroundJobs: {
      maxConcurrent: readPositiveInteger(
        backgroundJobs.max_concurrent,
        4,
        "background_jobs.max_concurrent",
      ),
    },
    approval: {
      mode: readToolApprovalMode(approval.mode, "unless_trusted"),
    },
    notification: {
      backend: readNotificationBackend(notification.backend, "auto"),
      onAgentCompleted: readBoolean(
        notification.on_agent_completed,
        true,
        "notification.on_agent_completed",
      ),
      onApprovalRequired: readBoolean(
        notification.on_approval_required,
        true,
        "notification.on_approval_required",
      ),
    },
    tui: {
      hyperlinks: readBoolean(tui.hyperlinks, true, "tui.hyperlinks"),
      renderLatex: readBoolean(tui.render_latex, true, "tui.render_latex"),
      renderMermaid: readBoolean(tui.render_mermaid, true, "tui.render_mermaid"),
      smoothTextStreaming: readBoolean(
        tui.smooth_text_streaming,
        true,
        "tui.smooth_text_streaming",
      ),
      collapseLongPastes: readBoolean(tui.collapse_long_pastes, true, "tui.collapse_long_pastes"),
    },
    logging: {
      level: readLogLevel(logging.level, "info"),
    },
  };
}

function resolveProviderConfig(
  rawProvider: Record<string, unknown>,
): ResolvedKanaConfig["provider"] {
  const deepseek = optionalRecord(rawProvider.deepseek, "provider.deepseek");
  const openAICodex = optionalRecord(rawProvider["openai-codex"], "provider.openai-codex");
  assertKnownKeys(deepseek, ["api_key_env", "timeout_ms", "max_retries"], "provider.deepseek");
  assertKnownKeys(openAICodex, ["timeout_ms", "max_retries"], "provider.openai-codex");

  return {
    deepseek: {
      apiKeyEnv: readEnvironmentVariable(
        deepseek.api_key_env,
        "DEEPSEEK_API_KEY",
        "provider.deepseek.api_key_env",
      ),
      timeoutMs: readPositiveInteger(deepseek.timeout_ms, 60_000, "provider.deepseek.timeout_ms"),
      maxRetries: readNonNegativeInteger(deepseek.max_retries, 1, "provider.deepseek.max_retries"),
    },
    "openai-codex": {
      timeoutMs: readPositiveInteger(
        openAICodex.timeout_ms,
        60_000,
        "provider.openai-codex.timeout_ms",
      ),
      maxRetries: readNonNegativeInteger(
        openAICodex.max_retries,
        1,
        "provider.openai-codex.max_retries",
      ),
    },
  };
}

function resolveModelConfig(rawModel: Record<string, unknown>): KanaModelConfigMap {
  const deepseek = optionalRecord(rawModel.deepseek, "model.deepseek");
  const openAICodex = optionalRecord(rawModel["openai-codex"], "model.openai-codex");
  assertModelNames(deepseek, Object.keys(DEEPSEEK_MODELS), "model.deepseek");
  assertModelNames(openAICodex, Object.keys(OPENAI_CODEX_MODELS), "model.openai-codex");

  return {
    deepseek: Object.fromEntries(
      Object.entries(DEEPSEEK_MODELS).map(([name, metadata]) => {
        const path = `model.deepseek.${name}`;
        const configured = optionalRecord(deepseek[name], path);
        const defaults = DEFAULT_DEEPSEEK_MODEL_CONFIG[name as keyof typeof DEEPSEEK_MODELS];
        assertKnownKeys(
          configured,
          ["reasoning_effort", "web_search", "image_input", "max_output_tokens", "context_limit"],
          path,
        );
        return [
          name,
          {
            reasoningEffort: readDeepSeekReasoningEffort(
              configured.reasoning_effort,
              defaults.reasoningEffort,
              `${path}.reasoning_effort`,
            ),
            webSearch: readBoolean(configured.web_search, defaults.webSearch, `${path}.web_search`),
            imageInput: readBoolean(
              configured.image_input,
              defaults.imageInput,
              `${path}.image_input`,
            ),
            maxOutputTokens: readBoundedMaxOutputTokens(
              configured.max_output_tokens,
              defaults.maxOutputTokens,
              metadata.maxOutputTokens,
              `${path}.max_output_tokens`,
            ),
            contextLimit: readContextLimit(
              configured.context_limit,
              defaults.contextLimit,
              `${path}.context_limit`,
              metadata.contextWindow,
            ),
          },
        ];
      }),
    ),
    "openai-codex": Object.fromEntries(
      Object.entries(OPENAI_CODEX_MODELS).map(([name, metadata]) => {
        const path = `model.openai-codex.${name}`;
        const configured = optionalRecord(openAICodex[name], path);
        const defaults =
          DEFAULT_OPENAI_CODEX_MODEL_CONFIG[name as keyof typeof OPENAI_CODEX_MODELS];
        assertKnownKeys(
          configured,
          [
            "reasoning_effort",
            "reasoning_summary",
            "web_search",
            "image_input",
            "max_output_tokens",
            "context_limit",
          ],
          path,
        );
        return [
          name,
          {
            reasoningEffort: readOpenAICodexReasoningEffort(
              configured.reasoning_effort,
              defaults.reasoningEffort,
              `${path}.reasoning_effort`,
            ),
            reasoningSummary: readOpenAICodexReasoningSummary(
              configured.reasoning_summary,
              defaults.reasoningSummary,
              `${path}.reasoning_summary`,
            ),
            webSearch: readBoolean(configured.web_search, defaults.webSearch, `${path}.web_search`),
            imageInput: readBoolean(
              configured.image_input,
              defaults.imageInput,
              `${path}.image_input`,
            ),
            maxOutputTokens: readBoundedMaxOutputTokens(
              configured.max_output_tokens,
              defaults.maxOutputTokens,
              metadata.maxOutputTokens,
              `${path}.max_output_tokens`,
            ),
            contextLimit: readContextLimit(
              configured.context_limit,
              defaults.contextLimit,
              `${path}.context_limit`,
              metadata.contextWindow,
            ),
          },
        ];
      }),
    ),
  };
}

type ResolveModelContext = {
  provider: ResolvedKanaConfig["provider"];
  model: KanaModelConfigMap;
  customProviderPath: string;
  loadCustomProvider(): KanaCustomProvider;
};

function resolveMainAgent(
  agent: Record<string, unknown>,
  context: ResolveModelContext,
  memoryEnabled: boolean,
): ResolvedKanaMainAgentConfig {
  assertKnownKeys(agent, MAIN_AGENT_KEYS, "agent");
  const repeated = optionalRecord(agent.repeated_tool_calls, "agent.repeated_tool_calls");
  assertKnownKeys(repeated, ["reminder_thresholds", "excluded_tools"], "agent.repeated_tool_calls");

  return {
    ...resolveAgentRuntime(agent, "agent", "deepseek", "deepseek-v4-pro", context),
    toolResultArtifacts: readBoolean(
      agent.tool_result_artifacts,
      true,
      "agent.tool_result_artifacts",
    ),
    repeatedToolCalls: {
      reminderThresholds: readReminderThresholds(
        repeated.reminder_thresholds,
        [3, 5, 8],
        "agent.repeated_tool_calls.reminder_thresholds",
      ),
      excludedTools: readExcludedToolNames(
        repeated.excluded_tools,
        [],
        "agent.repeated_tool_calls.excluded_tools",
      ),
    },
    memoryEnabled,
  };
}

function resolveMemoryAgent(
  agent: Record<string, unknown>,
  context: ResolveModelContext,
): ResolvedKanaMemoryAgentConfig {
  assertKnownKeys(agent, MEMORY_AGENT_KEYS, "memory.agent");
  return resolveAgentRuntime(agent, "memory.agent", "deepseek", "deepseek-v4-flash", context);
}

function resolveAgentRuntime(
  agent: Record<string, unknown>,
  path: string,
  defaultProvider: KanaModelProvider,
  defaultModel: string,
  context: ResolveModelContext,
): ResolvedKanaAgentRuntimeConfig {
  const provider = readModelProvider(agent.provider, defaultProvider, `${path}.provider`);
  const modelName = readString(agent.model, defaultModel, `${path}.model`);
  const model = resolveAgentModel(provider, modelName, agent, path, context);

  return {
    model,
    maxTurns: readAgentMaxTurns(
      agent.max_turns,
      DEFAULT_AGENT_RUNTIME.maxTurns,
      `${path}.max_turns`,
    ),
    toolDeadlineMs: readPositiveInteger(
      agent.tool_deadline_ms,
      DEFAULT_AGENT_RUNTIME.toolDeadlineMs,
      `${path}.tool_deadline_ms`,
    ),
    parallelToolCalls: readBoolean(
      agent.parallel_tool_calls,
      DEFAULT_AGENT_RUNTIME.parallelToolCalls,
      `${path}.parallel_tool_calls`,
    ),
    maxParallelToolCalls: readPositiveInteger(
      agent.max_parallel_tool_calls,
      DEFAULT_AGENT_RUNTIME.maxParallelToolCalls,
      `${path}.max_parallel_tool_calls`,
    ),
  };
}

function resolveAgentModel(
  provider: KanaModelProvider,
  modelName: string,
  overrides: Record<string, unknown>,
  path: string,
  context: ResolveModelContext,
): ResolvedKanaModelConfig {
  // Capability guards intentionally short-circuit parsing so inactive
  // provider-specific override values remain preserved but unvalidated.
  switch (provider) {
    case "deepseek": {
      const metadata = DEEPSEEK_MODELS[modelName as keyof typeof DEEPSEEK_MODELS];
      const defaults = context.model.deepseek[modelName];
      if (!metadata || !defaults) {
        throw new Error(`${path}.model must be a supported DeepSeek model.`);
      }
      return {
        provider,
        model: modelName,
        apiKeyEnv: context.provider.deepseek.apiKeyEnv,
        reasoningEffort: readDeepSeekReasoningEffort(
          overrides.reasoning_effort,
          defaults.reasoningEffort,
          `${path}.reasoning_effort`,
        ),
        webSearch:
          metadata.supportsHostedWebSearch &&
          readBoolean(overrides.web_search, defaults.webSearch, `${path}.web_search`),
        imageInput:
          metadata.supportsImageInput === true &&
          readBoolean(overrides.image_input, defaults.imageInput, `${path}.image_input`),
        maxOutputTokens: readBoundedMaxOutputTokens(
          overrides.max_output_tokens,
          defaults.maxOutputTokens,
          metadata.maxOutputTokens,
          `${path}.max_output_tokens`,
        ),
        contextLimit: readContextLimit(
          overrides.context_limit,
          defaults.contextLimit,
          `${path}.context_limit`,
          metadata.contextWindow,
        ),
        timeoutMs: context.provider.deepseek.timeoutMs,
        maxRetries: context.provider.deepseek.maxRetries,
      };
    }
    case "openai-codex": {
      const metadata = OPENAI_CODEX_MODELS[modelName as keyof typeof OPENAI_CODEX_MODELS];
      const defaults = context.model["openai-codex"][modelName];
      if (!metadata || !defaults) {
        throw new Error(`${path}.model must be a supported OpenAI Codex model.`);
      }
      return {
        provider,
        model: modelName,
        reasoningEffort: readOpenAICodexReasoningEffort(
          overrides.reasoning_effort,
          defaults.reasoningEffort,
          `${path}.reasoning_effort`,
        ),
        reasoningSummary: readOpenAICodexReasoningSummary(
          overrides.reasoning_summary,
          defaults.reasoningSummary,
          `${path}.reasoning_summary`,
        ),
        webSearch:
          metadata.supportsHostedWebSearch &&
          readBoolean(overrides.web_search, defaults.webSearch, `${path}.web_search`),
        imageInput:
          metadata.supportsImageInput === true &&
          readBoolean(overrides.image_input, defaults.imageInput, `${path}.image_input`),
        maxOutputTokens: readBoundedMaxOutputTokens(
          overrides.max_output_tokens,
          defaults.maxOutputTokens,
          metadata.maxOutputTokens,
          `${path}.max_output_tokens`,
        ),
        contextLimit: readContextLimit(
          overrides.context_limit,
          defaults.contextLimit,
          `${path}.context_limit`,
          metadata.contextWindow,
        ),
        timeoutMs: context.provider["openai-codex"].timeoutMs,
        maxRetries: context.provider["openai-codex"].maxRetries,
      };
    }
    case "custom": {
      const providerConfig = context.loadCustomProvider();
      const configured = getKanaCustomProviderModel(providerConfig, modelName);
      const metadata = configured.metadata;
      const reasoningEffort = metadata.reasoning
        ? resolveKanaCustomReasoning(
            configured,
            readOptionalString(
              overrides.reasoning_effort,
              configured.defaultReasoningEffort,
              `${path}.reasoning_effort`,
            ),
          )
        : undefined;
      const maxOutputTokens = readBoundedMaxOutputTokens(
        overrides.max_output_tokens,
        metadata.maxOutputTokens,
        metadata.maxOutputTokens,
        `${path}.max_output_tokens`,
      );
      const contextLimit = readContextLimit(
        overrides.context_limit,
        metadata.contextWindow,
        `${path}.context_limit`,
        metadata.contextWindow,
      );

      return {
        provider,
        model: modelName,
        baseUrl: providerConfig.baseUrl,
        apiKeyEnv: providerConfig.apiKeyEnv,
        metadata,
        reasoningEffort,
        providerConfigPath: context.customProviderPath,
        webSearch: false,
        imageInput:
          metadata.supportsImageInput === true &&
          readBoolean(overrides.image_input, true, `${path}.image_input`),
        maxOutputTokens,
        contextLimit,
        timeoutMs: providerConfig.timeoutMs,
        maxRetries: providerConfig.maxRetries,
      };
    }
  }
}

function assertModelNames(
  models: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const [name, value] of Object.entries(models)) {
    if (!allowed.includes(name)) {
      throw new Error(`${path}.${name} is not a supported model.`);
    }
    asRecord(value, `${path}.${name}`);
  }
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> {
  return value === undefined ? {} : asRecord(value, name);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a TOML table.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`${path}.${unknown} is not a supported setting.`);
  }
}

function readString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(
  value: unknown,
  fallback: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function readEnvironmentVariable(value: unknown, fallback: string, name: string): string {
  const variable = readString(value, fallback, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error(`${name} must be a valid environment variable name.`);
  }
  return variable;
}

function readBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function readNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
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

function readNonNegativeInteger(value: unknown, fallback: number, name: string): number {
  const number = readNumber(value, fallback, name);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return number;
}

function readOptionalPositiveInteger(
  value: unknown,
  fallback: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return fallback;
  return readPositiveInteger(value, 1, name);
}

function readAgentMaxTurns(value: unknown, fallback: number, name: string): number {
  const number = readNumber(value, fallback, name);
  if (number !== -1 && (!Number.isInteger(number) || number <= 0)) {
    throw new Error(`${name} must be -1 or a positive integer.`);
  }
  return number;
}

function readBoundedMaxOutputTokens(
  value: unknown,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const tokens = readPositiveInteger(value, fallback, name);
  if (tokens > maximum) {
    throw new Error(`${name} cannot exceed the model limit of ${maximum}.`);
  }
  return tokens;
}

function readContextLimit(
  value: unknown,
  fallback: number,
  name: string,
  maximum = fallback,
): number {
  return Math.min(readPositiveInteger(value, fallback, name), maximum);
}

function readModelProvider(
  value: unknown,
  fallback: KanaModelProvider,
  name: string,
): KanaModelProvider {
  const provider = readString(value, fallback, name);
  if (!(KANA_MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`${name} must be one of: ${KANA_MODEL_PROVIDERS.join(", ")}.`);
  }
  return provider as KanaModelProvider;
}

function readDeepSeekReasoningEffort(
  value: unknown,
  fallback: DeepSeekReasoningEffort,
  name: string,
): DeepSeekReasoningEffort {
  const effort = readString(value, fallback, name);
  if (!(KANA_DEEPSEEK_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`${name} must be one of: ${KANA_DEEPSEEK_REASONING_EFFORTS.join(", ")}.`);
  }
  return effort as DeepSeekReasoningEffort;
}

function readOpenAICodexReasoningEffort(
  value: unknown,
  fallback: OpenAICodexReasoningEffort,
  name: string,
): OpenAICodexReasoningEffort {
  const effort = readString(value, fallback, name);
  if (!(KANA_OPENAI_CODEX_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`${name} must be one of: ${KANA_OPENAI_CODEX_REASONING_EFFORTS.join(", ")}.`);
  }
  return effort as OpenAICodexReasoningEffort;
}

function readOpenAICodexReasoningSummary(
  value: unknown,
  fallback: OpenAICodexReasoningSummary,
  name: string,
): OpenAICodexReasoningSummary {
  const summary = readString(value, fallback, name);
  const summaries = ["auto", "concise", "detailed"] as const;
  if (!(summaries as readonly string[]).includes(summary)) {
    throw new Error(`${name} must be one of: ${summaries.join(", ")}.`);
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

function readLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  const level = readString(value, fallback, "logging.level");
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`logging.level must be one of: ${LOG_LEVELS.join(", ")}.`);
  }
  return level as LogLevel;
}

function readReminderThresholds(
  value: unknown,
  fallback: readonly number[],
  name: string,
): number[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  let previous = 1;
  const thresholds: number[] = [];
  for (const threshold of value) {
    if (
      typeof threshold !== "number" ||
      !Number.isInteger(threshold) ||
      threshold < 2 ||
      threshold <= previous
    ) {
      throw new Error(
        `${name} must contain strictly increasing integers greater than or equal to 2.`,
      );
    }
    thresholds.push(threshold);
    previous = threshold;
  }
  return thresholds;
}

function readExcludedToolNames(
  value: unknown,
  fallback: readonly string[],
  name: string,
): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  const names = new Set<string>();
  for (const toolName of value) {
    if (typeof toolName !== "string" || toolName.length === 0 || toolName !== toolName.trim()) {
      throw new Error(`${name} must contain non-empty trimmed tool names.`);
    }
    if (names.has(toolName)) throw new Error(`${name} must not contain duplicate tool names.`);
    names.add(toolName);
  }
  return [...names];
}
