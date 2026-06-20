import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { DeepSeekReasoningEffort } from "@/providers/deepseek";
import { DEFAULT_KANA_TOOL_APPROVALS } from "./tool-approval-defaults";

export type KanaModelConfig = {
  provider: "deepseek";
  name: string;
  apiKeyEnv: string;
  thinking: boolean;
  reasoningEffort: DeepSeekReasoningEffort;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
};

export type KanaAgentConfig = {
  maxTurns: number;
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

export type KanaMemoryConfig = {
  enabled: boolean;
  maxChars: number;
};

export type KanaConfig = {
  model: KanaModelConfig;
  agent: KanaAgentConfig;
  approval: KanaToolApprovalConfig;
  notification: KanaNotificationConfig;
  memory: KanaMemoryConfig;
};

export type KanaConfigPaths = {
  home: string;
  configPath: string;
  agentsPath: string;
  memoryDirectory: string;
  sessionsPath: string;
  approvalsPath: string;
};

export type InstallKanaConfigOptions = {
  force?: boolean;
};

export type InstallKanaConfigResult = {
  configPath: string;
  configStatus: "created" | "exists" | "reinstalled";
  approvalsPath: string;
  approvalsStatus: "created" | "exists" | "reinstalled";
};

export const DEFAULT_KANA_CONFIG: KanaConfig = {
  model: {
    provider: "deepseek",
    name: "deepseek-v4-pro",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    thinking: true,
    reasoningEffort: "high",
    maxTokens: 8192,
    timeoutMs: 60_000,
    maxRetries: 1,
  },
  agent: {
    maxTurns: -1,
  },
  approval: {
    mode: "unless_trusted",
  },
  notification: {
    backend: "auto",
    onAgentCompleted: true,
    onApprovalRequired: true,
  },
  memory: {
    enabled: true,
    maxChars: 6000,
  },
};

export function getKanaConfigPaths(env: NodeJS.ProcessEnv = process.env): KanaConfigPaths {
  const home = env.KANA_HOME ?? path.join(env.HOME ?? homedir(), ".kana");

  return {
    home,
    configPath: path.join(home, "config.toml"),
    agentsPath: path.join(home, "AGENTS.md"),
    memoryDirectory: path.join(home, "memory"),
    sessionsPath: path.join(home, "sessions"),
    approvalsPath: path.join(home, "approvals.json"),
  };
}

export function loadKanaConfig(env: NodeJS.ProcessEnv = process.env): KanaConfig {
  const { configPath } = getKanaConfigPaths(env);

  if (!existsSync(configPath)) {
    return DEFAULT_KANA_CONFIG;
  }

  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown;
  return mergeKanaConfig(DEFAULT_KANA_CONFIG, parsed);
}

export function installKanaConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: InstallKanaConfigOptions = {},
): InstallKanaConfigResult {
  const { home, configPath, approvalsPath } = getKanaConfigPaths(env);
  mkdirSync(home, { recursive: true });

  const configExists = existsSync(configPath);
  const approvalsExists = existsSync(approvalsPath);

  if (!configExists || options.force) {
    writeFileSync(configPath, serializeKanaConfig(DEFAULT_KANA_CONFIG), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  if (!approvalsExists || options.force) {
    writeFileSync(approvalsPath, `${JSON.stringify(DEFAULT_KANA_TOOL_APPROVALS, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return {
    configPath,
    configStatus:
      configExists && !options.force ? "exists" : configExists ? "reinstalled" : "created",
    approvalsPath,
    approvalsStatus:
      approvalsExists && !options.force ? "exists" : approvalsExists ? "reinstalled" : "created",
  };
}

function serializeKanaConfig(config: KanaConfig): string {
  return [
    "[model]",
    `provider = "${config.model.provider}"`,
    `name = "${config.model.name}"`,
    `api_key_env = "${config.model.apiKeyEnv}"`,
    `thinking = ${config.model.thinking}`,
    `reasoning_effort = "${config.model.reasoningEffort}"`,
    `max_tokens = ${config.model.maxTokens}`,
    `timeout_ms = ${config.model.timeoutMs}`,
    `max_retries = ${config.model.maxRetries}`,
    "",
    "[agent]",
    `max_turns = ${config.agent.maxTurns}`,
    "",
    "[approval]",
    `mode = "${config.approval.mode}"`,
    "",
    "[notification]",
    `backend = "${config.notification.backend}"`,
    `on_agent_completed = ${config.notification.onAgentCompleted}`,
    `on_approval_required = ${config.notification.onApprovalRequired}`,
    "",
    "[memory]",
    `enabled = ${config.memory.enabled}`,
    `max_chars = ${config.memory.maxChars}`,
    "",
  ].join("\n");
}

function mergeKanaConfig(defaults: KanaConfig, rawConfig: unknown): KanaConfig {
  const raw = asRecord(rawConfig, "config");
  const model = raw.model === undefined ? {} : asRecord(raw.model, "model");
  const agent = raw.agent === undefined ? {} : asRecord(raw.agent, "agent");
  const approval = raw.approval === undefined ? {} : asRecord(raw.approval, "approval");
  const notification =
    raw.notification === undefined ? {} : asRecord(raw.notification, "notification");
  const memory = raw.memory === undefined ? {} : asRecord(raw.memory, "memory");

  return {
    model: {
      provider: readDeepSeekProvider(model.provider, defaults.model.provider),
      name: readString(model.name, defaults.model.name, "model.name"),
      apiKeyEnv: readString(model.api_key_env, defaults.model.apiKeyEnv, "model.api_key_env"),
      thinking: readBoolean(model.thinking, defaults.model.thinking, "model.thinking"),
      reasoningEffort: readReasoningEffort(model.reasoning_effort, defaults.model.reasoningEffort),
      maxTokens: readNumber(model.max_tokens, defaults.model.maxTokens, "model.max_tokens"),
      timeoutMs: readNumber(model.timeout_ms, defaults.model.timeoutMs, "model.timeout_ms"),
      maxRetries: readNumber(model.max_retries, defaults.model.maxRetries, "model.max_retries"),
    },
    agent: {
      maxTurns: readNumber(agent.max_turns, defaults.agent.maxTurns, "agent.max_turns"),
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
    memory: {
      enabled: readBoolean(memory.enabled, defaults.memory.enabled, "memory.enabled"),
      maxChars: readPositiveInteger(memory.max_chars, defaults.memory.maxChars, "memory.max_chars"),
    },
  };
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

function readDeepSeekProvider(value: unknown, fallback: "deepseek"): "deepseek" {
  const provider = readString(value, fallback, "model.provider");

  if (provider !== "deepseek") {
    throw new Error(`Unsupported model.provider: ${provider}`);
  }

  return provider;
}

function readReasoningEffort(
  value: unknown,
  fallback: DeepSeekReasoningEffort,
): DeepSeekReasoningEffort {
  const effort = readString(value, fallback, "model.reasoning_effort");

  if (effort !== "high" && effort !== "max") {
    throw new Error(`model.reasoning_effort must be "high" or "max".`);
  }

  return effort;
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
