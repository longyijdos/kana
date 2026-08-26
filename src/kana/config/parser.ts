import { LOG_LEVELS } from "@/logging";
import type { OpenAICodexReasoningSummary } from "@/providers";
import {
  KANA_MODEL_PROVIDERS,
  KANA_NOTIFICATION_BACKENDS,
  KANA_TOOL_APPROVAL_MODES,
  type KanaConfig,
  type KanaLogLevel,
  type KanaModelConfig,
  type KanaModelProvider,
  type KanaNotificationBackend,
  type KanaToolApprovalMode,
} from "./contracts";
import { DEFAULT_KANA_CONFIG } from "./defaults";

const KANA_LOG_LEVELS = LOG_LEVELS;

export function parseKanaConfig(rawConfig: unknown): KanaConfig {
  return mergeKanaConfig(DEFAULT_KANA_CONFIG, rawConfig);
}

export function validateKanaConfig(config: KanaConfig): KanaConfig {
  return parseKanaConfig({
    provider: {
      deepseek: {
        api_key_env: config.provider.deepseek.apiKeyEnv,
        timeout_ms: config.provider.deepseek.timeoutMs,
        max_retries: config.provider.deepseek.maxRetries,
      },
      "openai-codex": {
        reasoning_summary: config.provider["openai-codex"].reasoningSummary,
        timeout_ms: config.provider["openai-codex"].timeoutMs,
        max_retries: config.provider["openai-codex"].maxRetries,
      },
    },
    agent: {
      web_search: config.agent.webSearch,
      image_input: config.agent.imageInput,
      max_turns: config.agent.maxTurns,
      goal_max_rounds: config.agent.goalMaxRounds,
      tool_deadline_ms: config.agent.toolDeadlineMs,
      parallel_tool_calls: config.agent.parallelToolCalls,
      max_parallel_tool_calls: config.agent.maxParallelToolCalls,
      tool_result_artifacts: config.agent.toolResultArtifacts,
      model: toRawModelConfig(config.agent.model),
      background_jobs: {
        max_concurrent: config.agent.backgroundJobs.maxConcurrent,
      },
      repeated_tool_calls: {
        reminder_thresholds: config.agent.repeatedToolCalls.reminderThresholds,
        excluded_tools: config.agent.repeatedToolCalls.excludedTools,
      },
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
      hyperlinks: config.tui.hyperlinks,
      render_latex: config.tui.renderLatex,
      render_mermaid: config.tui.renderMermaid,
      smooth_text_streaming: config.tui.smoothTextStreaming,
      collapse_long_pastes: config.tui.collapseLongPastes,
    },
    memory: {
      enabled: config.memory.enabled,
      max_chars: config.memory.maxChars,
      daily_retention_days: config.memory.dailyRetentionDays,
      agent: {
        web_search: config.memory.agent.webSearch,
        image_input: config.memory.agent.imageInput,
        max_turns: config.memory.agent.maxTurns,
        tool_deadline_ms: config.memory.agent.toolDeadlineMs,
        parallel_tool_calls: config.memory.agent.parallelToolCalls,
        max_parallel_tool_calls: config.memory.agent.maxParallelToolCalls,
        model: toRawModelConfig(config.memory.agent.model),
      },
    },
    logging: {
      level: config.logging.level,
    },
  });
}

function mergeKanaConfig(defaults: KanaConfig, rawConfig: unknown): KanaConfig {
  const raw = asRecord(rawConfig, "config");
  const provider = raw.provider === undefined ? {} : asRecord(raw.provider, "provider");
  const deepSeekProvider = readTable(provider.deepseek, "provider.deepseek");
  const openAICodexProvider = readTable(provider["openai-codex"], "provider.openai-codex");
  const agent = raw.agent === undefined ? {} : asRecord(raw.agent, "agent");
  const agentModel = readTable(agent.model, "agent.model");
  const backgroundJobs =
    agent.background_jobs === undefined
      ? {}
      : asRecord(agent.background_jobs, "agent.background_jobs");
  const repeatedToolCalls =
    agent.repeated_tool_calls === undefined
      ? {}
      : asRecord(agent.repeated_tool_calls, "agent.repeated_tool_calls");
  const approval = raw.approval === undefined ? {} : asRecord(raw.approval, "approval");
  const notification =
    raw.notification === undefined ? {} : asRecord(raw.notification, "notification");
  const tui = raw.tui === undefined ? {} : asRecord(raw.tui, "tui");
  const memory = raw.memory === undefined ? {} : asRecord(raw.memory, "memory");
  const memoryAgent = readTable(memory.agent, "memory.agent");
  const memoryAgentModel = readTable(memoryAgent.model, "memory.agent.model");
  const logging = raw.logging === undefined ? {} : asRecord(raw.logging, "logging");

  return {
    provider: {
      deepseek: {
        apiKeyEnv: readString(
          deepSeekProvider.api_key_env,
          defaults.provider.deepseek.apiKeyEnv,
          "provider.deepseek.api_key_env",
        ),
        timeoutMs: readNumber(
          deepSeekProvider.timeout_ms,
          defaults.provider.deepseek.timeoutMs,
          "provider.deepseek.timeout_ms",
        ),
        maxRetries: readNumber(
          deepSeekProvider.max_retries,
          defaults.provider.deepseek.maxRetries,
          "provider.deepseek.max_retries",
        ),
      },
      "openai-codex": {
        reasoningSummary: readOpenAICodexReasoningSummary(
          openAICodexProvider.reasoning_summary,
          defaults.provider["openai-codex"].reasoningSummary,
        ),
        timeoutMs: readNumber(
          openAICodexProvider.timeout_ms,
          defaults.provider["openai-codex"].timeoutMs,
          "provider.openai-codex.timeout_ms",
        ),
        maxRetries: readNumber(
          openAICodexProvider.max_retries,
          defaults.provider["openai-codex"].maxRetries,
          "provider.openai-codex.max_retries",
        ),
      },
    },
    agent: {
      webSearch: readBoolean(agent.web_search, defaults.agent.webSearch, "agent.web_search"),
      imageInput: readBoolean(agent.image_input, defaults.agent.imageInput, "agent.image_input"),
      maxTurns: readAgentMaxTurns(agent.max_turns, defaults.agent.maxTurns, "agent.max_turns"),
      goalMaxRounds: readPositiveInteger(
        agent.goal_max_rounds,
        defaults.agent.goalMaxRounds,
        "agent.goal_max_rounds",
      ),
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
      maxParallelToolCalls: readPositiveInteger(
        agent.max_parallel_tool_calls,
        defaults.agent.maxParallelToolCalls,
        "agent.max_parallel_tool_calls",
      ),
      model: parseModelConfig(agentModel, defaults.agent.model, "agent.model"),
      toolResultArtifacts: readBoolean(
        agent.tool_result_artifacts,
        defaults.agent.toolResultArtifacts,
        "agent.tool_result_artifacts",
      ),
      backgroundJobs: {
        maxConcurrent: readPositiveInteger(
          backgroundJobs.max_concurrent,
          defaults.agent.backgroundJobs.maxConcurrent,
          "agent.background_jobs.max_concurrent",
        ),
      },
      repeatedToolCalls: {
        reminderThresholds: readReminderThresholds(
          repeatedToolCalls.reminder_thresholds,
          defaults.agent.repeatedToolCalls.reminderThresholds,
          "agent.repeated_tool_calls.reminder_thresholds",
        ),
        excludedTools: readExcludedToolNames(
          repeatedToolCalls.excluded_tools,
          defaults.agent.repeatedToolCalls.excludedTools,
          "agent.repeated_tool_calls.excluded_tools",
        ),
      },
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
      hyperlinks: readBoolean(tui.hyperlinks, defaults.tui.hyperlinks, "tui.hyperlinks"),
      renderLatex: readBoolean(tui.render_latex, defaults.tui.renderLatex, "tui.render_latex"),
      renderMermaid: readBoolean(
        tui.render_mermaid,
        defaults.tui.renderMermaid ?? true,
        "tui.render_mermaid",
      ),
      smoothTextStreaming: readBoolean(
        tui.smooth_text_streaming,
        defaults.tui.smoothTextStreaming,
        "tui.smooth_text_streaming",
      ),
      collapseLongPastes: readBoolean(
        tui.collapse_long_pastes,
        defaults.tui.collapseLongPastes,
        "tui.collapse_long_pastes",
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
      agent: {
        webSearch: readBoolean(
          memoryAgent.web_search,
          defaults.memory.agent.webSearch,
          "memory.agent.web_search",
        ),
        imageInput: readBoolean(
          memoryAgent.image_input,
          defaults.memory.agent.imageInput,
          "memory.agent.image_input",
        ),
        maxTurns: readAgentMaxTurns(
          memoryAgent.max_turns,
          defaults.memory.agent.maxTurns,
          "memory.agent.max_turns",
        ),
        toolDeadlineMs: readPositiveInteger(
          memoryAgent.tool_deadline_ms,
          defaults.memory.agent.toolDeadlineMs,
          "memory.agent.tool_deadline_ms",
        ),
        parallelToolCalls: readBoolean(
          memoryAgent.parallel_tool_calls,
          defaults.memory.agent.parallelToolCalls,
          "memory.agent.parallel_tool_calls",
        ),
        maxParallelToolCalls: readPositiveInteger(
          memoryAgent.max_parallel_tool_calls,
          defaults.memory.agent.maxParallelToolCalls,
          "memory.agent.max_parallel_tool_calls",
        ),
        model: parseModelConfig(
          memoryAgentModel,
          defaults.memory.agent.model,
          "memory.agent.model",
        ),
      },
    },
    logging: {
      level: readLogLevel(logging.level, defaults.logging.level),
    },
  };
}

function toRawModelConfig(config: KanaModelConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    name: config.name,
    reasoning_effort: config.reasoningEffort,
    max_output_tokens: config.maxOutputTokens,
    context_limit: config.contextLimit,
  };
}

function parseModelConfig(
  model: Record<string, unknown>,
  defaults: KanaModelConfig,
  path: string,
): KanaModelConfig {
  return {
    provider: readModelProvider(model.provider, defaults.provider, `${path}.provider`),
    name: readString(model.name, defaults.name, `${path}.name`),
    reasoningEffort: readOptionalString(
      model.reasoning_effort,
      defaults.reasoningEffort,
      `${path}.reasoning_effort`,
    ),
    maxOutputTokens: readOptionalPositiveInteger(
      model.max_output_tokens,
      defaults.maxOutputTokens,
      `${path}.max_output_tokens`,
    ),
    contextLimit: readOptionalPositiveInteger(
      model.context_limit,
      defaults.contextLimit,
      `${path}.context_limit`,
    ),
  };
}

function readTable(value: unknown, name: string): Record<string, unknown> {
  return value === undefined ? {} : asRecord(value, name);
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

function readOptionalString(
  value: unknown,
  fallback: string | undefined,
  name: string,
): string | undefined {
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

function readReminderThresholds(
  value: unknown,
  fallback: readonly number[],
  name: string,
): number[] {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }

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
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }

  const names = new Set<string>();
  for (const toolName of value) {
    if (typeof toolName !== "string" || toolName.length === 0 || toolName !== toolName.trim()) {
      throw new Error(`${name} must contain non-empty trimmed tool names.`);
    }
    if (names.has(toolName)) {
      throw new Error(`${name} must not contain duplicate tool names.`);
    }
    names.add(toolName);
  }
  return [...names];
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

function readOpenAICodexReasoningSummary(
  value: unknown,
  fallback: OpenAICodexReasoningSummary,
): OpenAICodexReasoningSummary {
  const path = "provider.openai-codex.reasoning_summary";
  const summary = readString(value, fallback, path);
  const summaries = ["auto", "concise", "detailed"] as const;

  if (!(summaries as readonly string[]).includes(summary)) {
    throw new Error(`${path} must be one of: ${summaries.join(", ")}.`);
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
